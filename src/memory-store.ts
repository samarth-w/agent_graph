import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type {
  MemoryBackfillResult, MemoryCompactionResult, MemoryConflict, MemoryConflictResult, MemoryEvidenceInput,
  MemoryConfig,
  MemoryExpiryResult, MemoryPrincipalInput, MemoryPrincipalSnapshot, MemoryQueryEntry, MemoryQueryInput,
  MemoryQueryResult, MemoryRevocationInput, MemoryScoreComponents, MemoryStatus, MemoryType, MemoryWriteInput, MemoryWriteResult,
  MemoryMigrationReport, MemoryMetrics, MemoryAutoResolutionResult, MemoryObservability,
} from './types';
import { GraphDB } from './storage';
import { loadConfig } from './config';

const SCHEMA_VERSION = 1;
const sharedStores = new Map<string, NativeMemoryStore>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY, trust_tier TEXT NOT NULL, status TEXT NOT NULL,
  expires_at INTEGER, revoked_at INTEGER, metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, subject_key TEXT NOT NULL,
  memory_type TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_versions (
  version_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL, confidence REAL NOT NULL, evidence_ref_count INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER NOT NULL, valid_to INTEGER, supersedes_version_id TEXT, created_at INTEGER NOT NULL,
  status TEXT NOT NULL, idempotency_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_idempotency ON memory_versions(memory_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS memory_evidence (
  evidence_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL, excerpt_hash TEXT, captured_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_conflicts (
  conflict_id TEXT PRIMARY KEY, left_version_id TEXT NOT NULL, right_version_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL, resolution_state TEXT NOT NULL, winner_version_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_access_log (
  access_id TEXT PRIMARY KEY, principal_id TEXT, operation TEXT NOT NULL,
  request_fingerprint TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_rate_limits (bucket_key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_feedback (feedback_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, principal_id TEXT, relevance REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_operation_traces (trace_id TEXT PRIMARY KEY, operation TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, attributes_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory_records(namespace, subject_key, status);
CREATE INDEX IF NOT EXISTS idx_versions_memory_time ON memory_versions(memory_id, created_at DESC);
`;

function hash(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function parseMetadata(value: unknown): Record<string, unknown> { try { return JSON.parse(String(value ?? '{}')) as Record<string, unknown>; } catch { return {}; } }
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}
function tokenSimilarity(left: string, right: string): number {
  const a = tokenSet(left); const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export class NativeMemoryStore {
  private constructor(private readonly db: Database.Database, private readonly graph: GraphDB, private readonly rootDir: string) {}

  static open(graph: GraphDB): NativeMemoryStore {
    const memoryPath = path.join(path.dirname(graph.dbPath), 'memory.db');
    const existing = sharedStores.get(memoryPath);
    if (existing) return existing;
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    const db = new Database(memoryPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?,?)').run(SCHEMA_VERSION, Date.now());
    const rootDir = path.dirname(path.dirname(graph.dbPath));
    const store = new NativeMemoryStore(db, graph, rootDir);
    sharedStores.set(memoryPath, store);
    return store;
  }

  private getConfig(): MemoryConfig {
    return loadConfig(this.rootDir).memory ?? {};
  }

  private canAccessNamespace(principal: any, namespace: string): boolean {
    const metadata = parseMetadata(principal?.metadata_json);
    const namespaceList = metadata.namespaces;
    const hasList = Array.isArray(namespaceList);
    const defaultDeny = this.getConfig().defaultDenyNamespaceAccess === true;
    if (!hasList) return !defaultDeny;
    return namespaceList.includes(namespace);
  }

  static closeForGraphPath(graphPath: string): void {
    const memoryPath = path.join(path.dirname(graphPath), 'memory.db');
    const store = sharedStores.get(memoryPath);
    if (!store) return;
    store.db.close();
    sharedStores.delete(memoryPath);
  }

  private log(principalId: string | undefined, operation: string, fingerprint?: string): void {
    this.db.prepare('INSERT INTO memory_access_log(access_id, principal_id, operation, request_fingerprint, created_at) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), principalId ?? null, operation, fingerprint ?? null, Date.now());
  }

  private withBusyRetry<T>(operation: () => T): T {
    const attempts = 5;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return operation();
      } catch (error: any) {
        const message = String(error?.message ?? error);
        const isBusy = error?.code === 'SQLITE_BUSY' || /database is locked/i.test(message);
        if (!isBusy || attempt === attempts - 1) throw error;
        sleepSync(25 * (attempt + 1));
      }
    }
    throw new Error('Unreachable SQLite retry state');
  }

  consumeRateLimit(bucketKey: string, maxRequests: number, windowMs: number, nowMs: number): boolean {
    const consume = this.db.transaction(() => {
      const row = this.db.prepare('SELECT window_start,request_count FROM memory_rate_limits WHERE bucket_key=?').get(bucketKey) as any;
      if (!row || nowMs - Number(row.window_start) >= windowMs) {
        this.db.prepare('INSERT INTO memory_rate_limits(bucket_key,window_start,request_count) VALUES(?,?,?) ON CONFLICT(bucket_key) DO UPDATE SET window_start=excluded.window_start,request_count=excluded.request_count').run(bucketKey, nowMs, 1);
        return true;
      }
      if (Number(row.request_count) >= maxRequests) return false;
      this.db.prepare('UPDATE memory_rate_limits SET request_count=request_count+1 WHERE bucket_key=?').run(bucketKey);
      return true;
    });
    return consume();
  }

  registerPrincipal(input: MemoryPrincipalInput): MemoryPrincipalSnapshot {
    const now = Date.now(); const expiresAtMs = input.expiresAtMs;
    const trustTier = input.trustTier ?? 'neutral';
    const status: MemoryStatus = expiresAtMs && expiresAtMs <= now
      ? 'expired'
      : (trustTier === 'unverified' ? 'unverified' : 'active');
    this.db.prepare(`INSERT INTO principals(principal_id,trust_tier,status,expires_at,revoked_at,metadata_json)
      VALUES(?,?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET trust_tier=excluded.trust_tier,status=excluded.status,expires_at=excluded.expires_at,revoked_at=NULL,metadata_json=excluded.metadata_json`)
      .run(input.principalId, trustTier, status, expiresAtMs ?? null, null, JSON.stringify(input.metadata ?? {}));
    this.log(input.principalId, 'register');
    return { principalId: input.principalId, trustTier, status, expiresAtMs, metadata: input.metadata ?? {} };
  }

  revokePrincipal(input: MemoryRevocationInput): MemoryPrincipalSnapshot {
    const previous = this.db.prepare('SELECT * FROM principals WHERE principal_id=?').get(input.principalId) as any;
    const nowMs = input.nowMs ?? Date.now(); const metadata = { ...parseMetadata(previous?.metadata_json), reason: input.reason ?? 'revoked' };
    this.db.prepare(`INSERT INTO principals(principal_id,trust_tier,status,expires_at,revoked_at,metadata_json)
      VALUES(?,?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET status=excluded.status,revoked_at=excluded.revoked_at,metadata_json=excluded.metadata_json`)
      .run(input.principalId, previous?.trust_tier ?? 'neutral', 'revoked', previous?.expires_at ?? null, nowMs, JSON.stringify(metadata));
    this.log(input.principalId, 'revoke');
    return { principalId: input.principalId, trustTier: previous?.trust_tier ?? 'neutral', status: 'revoked', expiresAtMs: previous?.expires_at ?? undefined, revokedAtMs: nowMs, metadata };
  }

  writeMemory(input: MemoryWriteInput): MemoryWriteResult {
    const now = input.validFromMs ?? Date.now(); const payload = input.payload ?? {}; const payloadHash = hash(payload);
    const write = this.db.transaction((): MemoryWriteResult => {
      const principal = this.db.prepare('SELECT * FROM principals WHERE principal_id=?').get(input.principalId) as any;
      if (!principal) return { ok: false, error: `Unknown principal ${input.principalId}` };
      if (principal.status === 'revoked') return { ok: false, error: `Principal ${input.principalId} is revoked` };
      if (principal.status === 'expired' || (principal.expires_at && Number(principal.expires_at) <= now)) return { ok: false, error: `Principal ${input.principalId} is expired` };
      if (!this.canAccessNamespace(principal, input.namespace)) return { ok: false, error: `Namespace access denied for ${input.namespace}` };
      if (principal.status === 'unverified' && this.getConfig().allowUnverifiedWrites !== true) {
        return { ok: false, error: `Principal ${input.principalId} is unverified` };
      }
      const memoryId = input.memoryId ?? crypto.randomUUID();
      if (input.idempotencyKey) {
        const prior = this.db.prepare('SELECT version_id FROM memory_versions WHERE memory_id=? AND idempotency_key=?').get(memoryId, input.idempotencyKey) as any;
        if (prior) return { ok: true, memoryId, versionId: prior.version_id, status: 'active' };
      }
      const versionId = input.versionId ?? crypto.randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO memory_records(memory_id,namespace,subject_key,memory_type,created_by,created_at,status) VALUES(?,?,?,?,?,?,?)')
        .run(memoryId, input.namespace, input.subjectKey, input.memoryType ?? 'fact', input.principalId, now, 'active');
      const prior = this.db.prepare('SELECT version_id FROM memory_versions WHERE memory_id=? AND status=? ORDER BY created_at DESC, version_id DESC LIMIT 1').get(memoryId, 'active') as any;
      if (prior) this.db.prepare('UPDATE memory_versions SET status=? WHERE version_id=?').run('superseded', prior.version_id);
      this.db.prepare(`INSERT INTO memory_versions(version_id,memory_id,payload_json,payload_hash,confidence,evidence_ref_count,valid_from,valid_to,supersedes_version_id,created_at,status,idempotency_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, memoryId, JSON.stringify(payload), payloadHash, input.confidence ?? 0.5, input.evidence?.length ?? 0, now, input.validToMs ?? null, prior?.version_id ?? null, now, 'active', input.idempotencyKey ?? null);
      for (const evidence of input.evidence ?? []) this.addEvidence(versionId, evidence, now);
      const conflicts = this.db.prepare(`SELECT mv.version_id FROM memory_versions mv JOIN memory_records mr ON mr.memory_id=mv.memory_id
        WHERE mr.namespace=? AND mr.subject_key=? AND mr.memory_type=? AND mv.status='active' AND mv.version_id<>? AND mv.payload_hash<>?`).all(input.namespace, input.subjectKey, input.memoryType ?? 'fact', versionId, payloadHash) as any[];
      for (const other of conflicts) {
        const exists = this.db.prepare(`SELECT conflict_id FROM memory_conflicts WHERE ((left_version_id=? AND right_version_id=?) OR (left_version_id=? AND right_version_id=?)) AND resolution_state='open'`).get(versionId, other.version_id, other.version_id, versionId);
        if (!exists) this.db.prepare('INSERT INTO memory_conflicts VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), versionId, other.version_id, 'contradiction', 'open', null, now);
      }
      this.log(input.principalId, prior ? 'revise' : 'create', memoryId);
      return { ok: true, memoryId, versionId, status: 'active' };
    });
    const result = this.withBusyRetry(write);
    if (result.ok && this.getConfig().autoResolveConflicts === true) this.autoResolveConflicts();
    return result;
  }

  private addEvidence(versionId: string, evidence: MemoryEvidenceInput, now: number): void {
    this.db.prepare('INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), versionId, evidence.sourceType, evidence.sourceRef, evidence.excerptHash ?? null, evidence.capturedAtMs ?? now);
  }

  queryMemory(input: MemoryQueryInput): MemoryQueryResult {
    const now = input.nowMs ?? Date.now();
    if (input.principalId) {
      const requester = this.db.prepare('SELECT * FROM principals WHERE principal_id=?').get(input.principalId) as any;
      if (!requester || requester.status === 'revoked' || requester.status === 'expired') return { results: [], total: 0 };
      if (!this.canAccessNamespace(requester, input.namespace)) return { results: [], total: 0 };
    }
    const args: unknown[] = [input.namespace, input.subjectKey]; let typeClause = '';
    if (input.memoryType) { typeClause = ' AND mr.memory_type=?'; args.push(input.memoryType); }
    const rows = this.db.prepare(`SELECT mv.*,mr.namespace,mr.subject_key,mr.memory_type,mr.created_by FROM memory_versions mv JOIN memory_records mr ON mr.memory_id=mv.memory_id WHERE mr.namespace=? AND mr.subject_key=? AND mr.status<>'tombstoned'${typeClause}`).all(...args) as any[];
    const results: MemoryQueryEntry[] = [];
    for (const row of rows) {
      const principal = this.db.prepare('SELECT * FROM principals WHERE principal_id=?').get(row.created_by) as any;
      const expired = row.status === 'expired' || (row.valid_to && Number(row.valid_to) <= now); const superseded = row.status === 'superseded';
      if (!principal || principal.status === 'revoked' || (!input.includeExpired && expired) || (!input.includeSuperseded && superseded) || (input.requireEvidence && row.evidence_ref_count === 0)) continue;
      const trust = principal.trust_tier === 'trusted' ? 1 : principal.trust_tier === 'neutral' ? .6 : .3;
      const recency = Math.max(.1, 1 - Math.min(1, (now - Number(row.created_at)) / 604800000)); const confidence = Number(row.confidence); const evidence = Math.min(1, Number(row.evidence_ref_count) / 2); const penalty = expired ? .45 : 0;
      const semantic = input.semanticQuery ? tokenSimilarity(input.semanticQuery, `${row.subject_key} ${row.payload_json}`) : 0;
      const feedbackRow = this.db.prepare('SELECT AVG(relevance) AS relevance FROM memory_feedback WHERE version_id=?').get(row.version_id) as { relevance?: number | null } | undefined;
      const adaptive = feedbackRow?.relevance === null || feedbackRow?.relevance === undefined ? 0.5 : Math.max(0, Math.min(1, Number(feedbackRow.relevance)));
      const hybridEnabled = this.getConfig().hybridRankingEnabled === true;
      const scoreComponents: MemoryScoreComponents = { trust, recency, confidence, evidence, penalty, ...(hybridEnabled ? { semantic, adaptive } : {}) };
      const evidenceRefs = this.db.prepare('SELECT source_type,source_ref,excerpt_hash FROM memory_evidence WHERE version_id=? ORDER BY captured_at,evidence_id').all(row.version_id).map((e: any) => ({ sourceType: e.source_type, sourceRef: e.source_ref, ...(e.excerpt_hash ? { excerptHash: e.excerpt_hash } : {}) }));
      const baseScore = .35 * trust + .25 * recency + .2 * confidence + .2 * evidence - penalty;
      const score = hybridEnabled ? (.8 * baseScore + .15 * semantic + .05 * adaptive) : baseScore;
      results.push({ memoryId: row.memory_id, versionId: row.version_id, namespace: row.namespace, subjectKey: row.subject_key, memoryType: row.memory_type as MemoryType, payload: JSON.parse(row.payload_json), confidence, status: row.status as MemoryStatus, score, scoreComponents, evidenceCount: row.evidence_ref_count, createdAt: row.created_at, policyWarnings: [ ...(expired ? ['expired'] : []), ...(row.evidence_ref_count === 0 ? ['low evidence'] : []) ], acceptedRules: ['principal active', 'validity accepted', ...(row.evidence_ref_count ? ['evidence present'] : []), ...(hybridEnabled ? ['hybrid semantic policy'] : [])], evidenceRefs });
    }
    results.sort((a,b) => b.score-a.score || b.scoreComponents.trust-a.scoreComponents.trust || b.createdAt-a.createdAt || a.versionId.localeCompare(b.versionId));
    this.log(input.principalId, 'query', `${input.namespace}:${input.subjectKey}`);
    return { results: results.slice(0, input.limit && input.limit > 0 ? input.limit : results.length), total: results.length };
  }

  resolveConflict(input: { leftVersionId: string; rightVersionId: string; conflictType?: string; winnerVersionId?: string }): MemoryConflictResult {
    const found = this.db.prepare(`SELECT conflict_id FROM memory_conflicts WHERE ((left_version_id=? AND right_version_id=?) OR (left_version_id=? AND right_version_id=?)) AND resolution_state='open'`).get(input.leftVersionId,input.rightVersionId,input.rightVersionId,input.leftVersionId) as any;
    if (found && input.winnerVersionId) { this.db.prepare('UPDATE memory_conflicts SET resolution_state=?,winner_version_id=? WHERE conflict_id=?').run('winner_selected',input.winnerVersionId,found.conflict_id); this.log(undefined,'resolve',found.conflict_id); return { conflictId: found.conflict_id, resolutionState:'winner_selected' }; }
    const conflictId=crypto.randomUUID(); const state=input.winnerVersionId?'winner_selected':'open'; this.db.prepare('INSERT INTO memory_conflicts VALUES(?,?,?,?,?,?,?)').run(conflictId,input.leftVersionId,input.rightVersionId,input.conflictType??'contradiction',state,input.winnerVersionId??null,Date.now()); this.log(undefined,'resolve',conflictId); return { conflictId, resolutionState:state };
  }
  recordFeedback(input: { versionId: string; relevance: number; principalId?: string }): void {
    this.db.prepare('INSERT INTO memory_feedback(feedback_id,version_id,principal_id,relevance,created_at) VALUES(?,?,?,?,?)')
      .run(crypto.randomUUID(), input.versionId, input.principalId ?? null, Math.max(0, Math.min(1, input.relevance)), Date.now());
    this.log(input.principalId, 'feedback', input.versionId);
  }
  autoResolveConflicts(input: { minimumMargin?: number } = {}): MemoryAutoResolutionResult {
    const minimumMargin = input.minimumMargin ?? this.getConfig().autoResolveMinimumMargin ?? .15;
    const conflicts = this.db.prepare("SELECT * FROM memory_conflicts WHERE resolution_state='open' ORDER BY created_at,conflict_id").all() as any[];
    const conflictIds: string[] = []; let resolvedCount = 0;
    for (const conflict of conflicts) {
      const rows = this.db.prepare(`SELECT mv.version_id,mv.confidence,mv.evidence_ref_count,mv.created_at,p.trust_tier FROM memory_versions mv JOIN memory_records mr ON mr.memory_id=mv.memory_id JOIN principals p ON p.principal_id=mr.created_by WHERE mv.version_id IN (?,?)`).all(conflict.left_version_id, conflict.right_version_id) as any[];
      if (rows.length !== 2) continue;
      const rank = (row: any) => (row.trust_tier === 'trusted' ? .35 : row.trust_tier === 'neutral' ? .21 : .105) + .2 * Number(row.confidence) + .2 * Math.min(1, Number(row.evidence_ref_count) / 2);
      const [first, second] = rows.sort((a, b) => rank(b) - rank(a) || Number(b.created_at) - Number(a.created_at) || String(a.version_id).localeCompare(String(b.version_id)));
      if (rank(first) - rank(second) < minimumMargin) continue;
      this.db.prepare("UPDATE memory_conflicts SET resolution_state='winner_selected',winner_version_id=? WHERE conflict_id=?").run(first.version_id, conflict.conflict_id);
      conflictIds.push(conflict.conflict_id); resolvedCount++;
    }
    this.log(undefined, 'auto_resolve');
    return { resolvedCount, unresolvedCount: conflicts.length - resolvedCount, conflictIds };
  }
  listConflicts(input: { versionId?: string; includeResolved?: boolean } = {}): MemoryConflict[] { const rows = input.versionId ? this.db.prepare(`SELECT * FROM memory_conflicts WHERE (left_version_id=? OR right_version_id=?)${input.includeResolved?'':" AND resolution_state='open'"} ORDER BY created_at,conflict_id`).all(input.versionId,input.versionId) : this.db.prepare(`SELECT * FROM memory_conflicts ${input.includeResolved?'':"WHERE resolution_state='open'"} ORDER BY created_at,conflict_id`).all(); return rows.map((r:any)=>({conflictId:r.conflict_id,leftVersionId:r.left_version_id,rightVersionId:r.right_version_id,conflictType:r.conflict_type,resolutionState:r.resolution_state,winnerVersionId:r.winner_version_id??undefined,createdAt:r.created_at})); }
  expireMemory(input:{nowMs?:number}):MemoryExpiryResult { const now=input.nowMs??Date.now(); const result=this.db.prepare(`UPDATE memory_versions SET status='expired' WHERE status<>'expired' AND valid_to IS NOT NULL AND valid_to<=?`).run(now); this.log(undefined,'expire'); return {expiredCount:result.changes}; }
  compactMemory(input:{nowMs?:number;retentionMs?:number}):MemoryCompactionResult { const now=input.nowMs??Date.now(), retention=input.retentionMs??this.getConfig().defaultRetentionMs??604800000; const result=this.db.prepare(`UPDATE memory_records SET status='tombstoned' WHERE status<>'tombstoned' AND memory_id IN (SELECT DISTINCT memory_id FROM memory_versions WHERE status IN ('expired','revoked') AND created_at<?)`).run(now-retention); this.log(undefined,'compact'); return {tombstonedCount:result.changes}; }

  getMetrics(): MemoryMetrics {
    const operationRows = this.db.prepare('SELECT operation, COUNT(*) AS count FROM memory_access_log GROUP BY operation ORDER BY operation').all() as Array<{ operation: string; count: number }>;
    const count = (sql: string): number => Number((this.db.prepare(sql).get() as { count?: number } | undefined)?.count ?? 0);
    return {
      operations: Object.fromEntries(operationRows.map((row) => [row.operation, Number(row.count)])),
      openConflicts: count("SELECT COUNT(*) AS count FROM memory_conflicts WHERE resolution_state='open'"),
      activeVersions: count("SELECT COUNT(*) AS count FROM memory_versions WHERE status='active'"),
      expiredVersions: count("SELECT COUNT(*) AS count FROM memory_versions WHERE status='expired'"),
      tombstonedRecords: count("SELECT COUNT(*) AS count FROM memory_records WHERE status='tombstoned'"),
      rateLimitBuckets: count('SELECT COUNT(*) AS count FROM memory_rate_limits'),
    };
  }

  recordTrace(input: { operation: string; durationMs: number; status: 'ok' | 'error'; attributes?: Record<string, unknown> }): void {
    this.db.prepare('INSERT INTO memory_operation_traces(trace_id,operation,duration_ms,status,attributes_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(crypto.randomUUID(), input.operation, Math.max(0, input.durationMs), input.status, JSON.stringify(input.attributes ?? {}), Date.now());
  }

  getObservability(): MemoryObservability {
    const rows = this.db.prepare('SELECT operation,duration_ms FROM memory_operation_traces ORDER BY created_at').all() as Array<{ operation: string; duration_ms: number }>;
    const grouped = new Map<string, number[]>();
    for (const row of rows) grouped.set(row.operation, [...(grouped.get(row.operation) ?? []), Number(row.duration_ms)]);
    const percentile = (values: number[], p: number): number => values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(values.length * p))];
    const operationLatencyMs: MemoryObservability['operationLatencyMs'] = {};
    for (const [operation, values] of grouped) {
      values.sort((a, b) => a - b);
      operationLatencyMs[operation] = { count: values.length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) };
    }
    const alerts: MemoryObservability['alerts'] = [];
    for (const [operation, latency] of Object.entries(operationLatencyMs)) {
      if (latency.p95 > 500) alerts.push({ name: `${operation}_p95_latency`, severity: 'warning', value: latency.p95, threshold: 500 });
    }
    const openConflicts = this.getMetrics().openConflicts;
    if (openConflicts > 100) alerts.push({ name: 'open_conflicts', severity: 'critical', value: openConflicts, threshold: 100 });
    return { operationLatencyMs, alerts };
  }

  getMigrationReport(): MemoryMigrationReport {
    const legacyNodes = this.graph.getAllNodes().filter((node) => {
      const file = this.graph.getFileById(node.file_id);
      return Boolean(file?.path.startsWith('a2a/') && node.doc);
    });
    const importedLegacyRow = this.db.prepare("SELECT COUNT(*) as c FROM memory_versions WHERE idempotency_key LIKE 'legacy:%'").get() as { c?: number } | undefined;
    const importedLegacyRecords = Number(importedLegacyRow?.c ?? 0);
    let parityMismatches = 0;
    for (const node of legacyNodes) {
      const file = this.graph.getFileById(node.file_id);
      const key = `legacy:${node.id}`;
      const imported = this.db.prepare('SELECT payload_json FROM memory_versions WHERE idempotency_key=? ORDER BY created_at DESC LIMIT 1').get(key) as any;
      if (!imported) {
        parityMismatches++;
        continue;
      }
      try {
        const importedPayload = JSON.parse(String(imported.payload_json));
        const legacyPayload = JSON.parse(String(node.doc));
        if (hash(importedPayload) !== hash(legacyPayload)) parityMismatches++;
      } catch {
        if (String(imported.payload_json) !== String(node.doc)) parityMismatches++;
      }
      if (!file?.path.startsWith('a2a/')) parityMismatches++;
    }
    return {
      totalLegacyNodes: legacyNodes.length,
      importedLegacyRecords,
      skippedLegacyRecords: Math.max(0, legacyNodes.length - importedLegacyRecords),
      parityMismatches,
    };
  }

  backfillLegacyA2AMemory(): MemoryBackfillResult {
    let importedCount = 0;
    let skippedCount = 0;
    const legacyNodes = this.graph.getAllNodes().filter((node) => {
      const file = this.graph.getFileById(node.file_id);
      return Boolean(file?.path.startsWith('a2a/') && node.doc);
    });

    for (const node of legacyNodes) {
      const file = this.graph.getFileById(node.file_id);
      if (!file?.path.startsWith('a2a/') || !node.doc) continue;
      const key = `legacy:${node.id}`;
      if (this.db.prepare('SELECT version_id FROM memory_versions WHERE idempotency_key=?').get(key)) {
        skippedCount++;
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(node.doc) as Record<string, unknown>;
      } catch {
        payload = { doc: node.doc };
      }
      const principalId = typeof payload.agent_id === 'string' ? payload.agent_id : 'legacy-import';
      if (!this.db.prepare('SELECT 1 FROM principals WHERE principal_id=?').get(principalId)) {
        this.registerPrincipal({ principalId, trustTier: 'legacy', metadata: { imported: true, namespaces: ['legacy-a2a'] } });
      }
      const result = this.writeMemory({
        principalId,
        namespace: 'legacy-a2a',
        subjectKey: node.qualified_name,
        memoryType: 'observation',
        payload,
        confidence: 0.4,
        evidence: [{ sourceType: 'legacy_import', sourceRef: file.path }],
        idempotencyKey: key,
      });
      if (result.ok) importedCount++; else skippedCount++;
    }
    this.log(undefined, 'backfill');
    const report = this.getMigrationReport();
    return {
      totalLegacyNodes: report.totalLegacyNodes,
      importedCount,
      skippedCount,
      parityMismatches: report.parityMismatches,
    };
  }
}
