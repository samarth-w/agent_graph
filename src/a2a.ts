import http from 'http';
import crypto from 'crypto';
import { GraphDB } from './storage';
import { MemoryService } from './memory';
import { syncProvenance } from './provenance';
import { replicateMemoryWrite } from './memory-replication';
import { getDbPath, loadConfig } from './config';
import type { A2AAgentCard, A2ARpcRequest, A2ARpcResponse, EdgeCost, NodeRecord } from './types';

const CARD_VERSION = '0.1.0';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

interface RateLimitPolicy {
  maxRequests: number;
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

interface AgentTrustState {
  trustStatus: 'verified' | 'unverified' | 'revoked' | 'expired';
  expiresAtMs?: number;
}

interface HandleA2ARequestOptions {
  headers?: Record<string, string | string[] | undefined>;
  clientKey?: string;
  nowMs?: number;
}

const PROTECTED_A2A_METHODS = new Set([
  'read_lineage',
  'query_by_agent',
  'memory.query',
  'query_memory',
  'memory.conflicts',
  'memory.migration_report',
  'memory.metrics',
  'register_agent',
  'revoke_agent',
  'write_node',
  'memory.register_principal',
  'register_memory_principal',
  'memory.write',
  'memory.revise',
  'write_memory',
  'revise_memory',
  'memory.replication.apply',
  'memory.revoke_principal',
  'memory.expire',
  'memory.resolve_conflict',
  'resolve_memory_conflict',
  'memory.compact',
  'compact_memory',
  'memory.backfill',
  'memory.feedback',
  'memory.auto_resolve',
  'memory.affected',
  'memory.sync_provenance',
  'memory.revalidate',
]);

export function getAgentCard(): A2AAgentCard {
  return {
    name: 'cgraph-a2a-adapter',
    version: CARD_VERSION,
    transport: 'http+jsonrpc',
    capabilities: [
      { name: 'register_agent', implemented: true, description: 'Register an agent capability claim signed with Ed25519.' },
      { name: 'revoke_agent', implemented: true, description: 'Revoke a previously registered agent to disable verified trust status.' },
      { name: 'write_node', implemented: true, description: 'Persist an agent-authored node into graph storage.' },
      { name: 'read_lineage', implemented: true, description: 'Return parent lineage for a node by traversing incoming references.' },
      { name: 'query_by_agent', implemented: true, description: 'Query node records authored by an agent.' },
      { name: 'memory.register_principal', implemented: true, description: 'Register a principal for canonical memory writes.' },
      { name: 'memory.write', implemented: true, description: 'Create or revise a persistent memory record.' },
      { name: 'memory.query', implemented: true, description: 'Query persistent memory results for a subject.' },
      { name: 'memory.backfill', implemented: true, description: 'Backfill legacy A2A records into persistent memory.' },
      { name: 'memory.migration_report', implemented: true, description: 'Report legacy-to-memory migration parity metrics.' },
      { name: 'memory.metrics', implemented: true, description: 'Return persistent-memory audit and lifecycle metrics.' },
      { name: 'memory.feedback', implemented: true, description: 'Record adaptive-ranking relevance feedback.' },
      { name: 'memory.auto_resolve', implemented: true, description: 'Automatically resolve sufficiently clear conflicts.' },
      { name: 'memory.affected', implemented: true, description: 'List memory versions affected by evidence or provenance changes.' },
      { name: 'memory.sync_provenance', implemented: true, description: 'Detect semantic symbol-level code changes and invalidate dependent memories.' },
      { name: 'memory.revalidate', implemented: true, description: 'Revalidate a stale memory version and restore it to active state.' },
    ],
  };
}

function rpcResult(id: string | number | null | undefined, result: unknown): A2ARpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown): A2ARpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function parseCost(value: unknown): EdgeCost {
  if (!value || typeof value !== 'object') return {};
  const c = value as Record<string, unknown>;
  return {
    tokens_in: typeof c.tokens_in === 'number' ? c.tokens_in : undefined,
    tokens_out: typeof c.tokens_out === 'number' ? c.tokens_out : undefined,
    latency_ms: typeof c.latency_ms === 'number' ? c.latency_ms : undefined,
    est_cost_usd: typeof c.est_cost_usd === 'number' ? c.est_cost_usd : undefined,
  };
}

type TrustMode = 'registration_only' | 'per_write';

interface TrustPolicy {
  mode: TrustMode;
  maxVerifyLatencyMs: number;
  allowFallback: boolean;
}

function agentNodePath(): string {
  return 'a2a/agents.json';
}

function agentQName(agentId: string): string {
  return `${agentNodePath()}::agent:${agentId}`;
}

function parseAgentTrust(doc: string | null, nowMs: number = Date.now()): AgentTrustState {
  if (!doc) return { trustStatus: 'unverified' };
  try {
    const parsed = JSON.parse(doc) as { trust_status?: string; expires_at?: string };
    if (parsed.trust_status === 'revoked') {
      return { trustStatus: 'revoked' };
    }
    if (parsed.trust_status === 'verified') {
      const expiresAtMs = typeof parsed.expires_at === 'string'
        ? Date.parse(parsed.expires_at)
        : Number.NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
        return { trustStatus: 'expired', expiresAtMs };
      }
      return {
        trustStatus: 'verified',
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
      };
    }
    return { trustStatus: 'unverified' };
  } catch {
    return { trustStatus: 'unverified' };
  }
}

function verifyEd25519Claim(claim: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length === 0) return false;
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(claim, 'utf-8'), key, signature);
  } catch {
    return false;
  }
}

function parseTrustMode(value: unknown): TrustMode | undefined {
  return value === 'registration_only' || value === 'per_write'
    ? value
    : undefined;
}

function getConfiguredA2AAuthToken(rootDir: string): string | undefined {
  const config = loadConfig(rootDir);
  return config.a2a?.authToken
    ?? process.env.CGRAPH_A2A_TOKEN
    ?? process.env.CGRAPH_A2A_AUTH_TOKEN
    ?? undefined;
}

function getConfiguredBodyLimit(rootDir: string): number {
  const config = loadConfig(rootDir);
  return typeof config.a2a?.maxBodyBytes === 'number' && config.a2a.maxBodyBytes > 0
    ? config.a2a.maxBodyBytes
    : DEFAULT_MAX_BODY_BYTES;
}

function getConfiguredRegistrationTtl(rootDir: string, params: Record<string, unknown>): number | undefined {
  const config = loadConfig(rootDir);
  const requested = typeof params.registration_ttl_ms === 'number'
    ? params.registration_ttl_ms
    : undefined;
  const configured = typeof config.a2a?.registrationTtlMs === 'number'
    ? config.a2a.registrationTtlMs
    : undefined;
  const ttl = requested ?? configured;
  return typeof ttl === 'number' && ttl > 0 ? ttl : undefined;
}

function getConfiguredRateLimit(rootDir: string): RateLimitPolicy | undefined {
  const config = loadConfig(rootDir);
  const maxRequests = config.a2a?.rateLimitMaxRequests;
  const windowMs = config.a2a?.rateLimitWindowMs;
  if (typeof maxRequests === 'number' && maxRequests > 0 && typeof windowMs === 'number' && windowMs > 0) {
    return { maxRequests, windowMs };
  }
  return undefined;
}

function isMemoryServiceEnabled(rootDir: string): boolean {
  return loadConfig(rootDir).memory?.enabled !== false;
}

async function enforceRateLimit(rootDir: string, clientKey: string | undefined, nowMs: number): Promise<string | undefined> {
  const policy = getConfiguredRateLimit(rootDir);
  if (!policy) return undefined;

  const key = `${rootDir}::${clientKey ?? 'unknown'}`;
  const db = await GraphDB.open(getDbPath(rootDir));
  const allowed = new MemoryService(db).consumeRateLimit(key, policy.maxRequests, policy.windowMs, nowMs);
  return allowed ? undefined : `Rate limit exceeded: max ${policy.maxRequests} requests per ${policy.windowMs}ms window.`;
}

function getHeaderValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function getProvidedAuthToken(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  const direct = getHeaderValue(headers, 'x-cgraph-a2a-token')
    ?? getHeaderValue(headers, 'x-cgraph-auth-token');
  if (direct) return direct;

  const authorization = getHeaderValue(headers, 'authorization');
  if (!authorization) return undefined;
  const bearer = authorization.trim();
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim();
  }
  return bearer;
}

function ensureAuthorized(method: string, rootDir: string, requestId: string | number | null | undefined, headers?: Record<string, string | string[] | undefined>): A2ARpcResponse | undefined {
  if (!PROTECTED_A2A_METHODS.has(method)) return undefined;

  const expectedToken = getConfiguredA2AAuthToken(rootDir);
  if (!expectedToken) return undefined;

  const providedToken = getProvidedAuthToken(headers);
  if (providedToken !== expectedToken) {
    return rpcError(requestId, -32001, 'Authentication required for this endpoint.');
  }

  return undefined;
}

function getTrustPolicy(rootDir: string, params: Record<string, unknown>): TrustPolicy {
  const config = loadConfig(rootDir);
  const configuredMode = parseTrustMode(config.a2a?.trustMode);
  const requestedMode = parseTrustMode(params.trust_mode);
  const mode = requestedMode ?? configuredMode ?? 'registration_only';

  const configuredLatency = typeof config.a2a?.maxVerifyLatencyMs === 'number'
    ? config.a2a.maxVerifyLatencyMs
    : 10;
  const requestedLatency = typeof params.max_verify_latency_ms === 'number'
    ? params.max_verify_latency_ms
    : undefined;
  const maxVerifyLatencyMs = requestedLatency ?? configuredLatency;

  const configuredFallback = typeof config.a2a?.allowVerifyFallback === 'boolean'
    ? config.a2a.allowVerifyFallback
    : true;
  const requestedFallback = typeof params.allow_verify_fallback === 'boolean'
    ? params.allow_verify_fallback
    : undefined;
  const allowFallback = requestedFallback ?? configuredFallback;

  return {
    mode,
    maxVerifyLatencyMs,
    allowFallback,
  };
}

function getFilePathForNode(db: GraphDB, node: NodeRecord): string {
  const file = db.getFileById(node.file_id);
  return file?.path ?? '';
}

function findNodeByQuery(db: GraphDB, query: string): NodeRecord | undefined {
  const byQName = db.findNodeByQName(query);
  if (byQName) return byQName;
  const byName = db.findNodesByName(query);
  if (byName.length > 0) return byName[0];
  return undefined;
}

export async function handleA2ARpcRequest(rootDir: string, request: A2ARpcRequest, opts: HandleA2ARequestOptions = {}): Promise<A2ARpcResponse> {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const rateLimitError = await enforceRateLimit(rootDir, opts.clientKey, nowMs);
  if (rateLimitError) {
    return rpcError(request?.id, -32029, rateLimitError);
  }

  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(request?.id, -32600, 'Invalid Request');
  }

  if (request.method === 'agent.card' || request.method === 'a2a.discover') {
    return rpcResult(request.id, getAgentCard());
  }

  const authError = ensureAuthorized(request.method, rootDir, request.id, opts.headers);
  if (authError) return authError;

  if (request.method === 'memory.register_principal' || request.method === 'register_memory_principal') {
    const params = request.params ?? {};
    const principalId = typeof params.principal_id === 'string' && params.principal_id.length > 0
      ? params.principal_id
      : undefined;
    const trustTier = typeof params.trust_tier === 'string' && params.trust_tier.length > 0
      ? params.trust_tier
      : 'neutral';
    if (!principalId) {
      return rpcError(request.id, -32602, 'Invalid params: "principal_id" is required.');
    }
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.registerPrincipal({ principalId, trustTier, expiresAtMs: typeof params.expires_at_ms === 'number' ? params.expires_at_ms : undefined, metadata: typeof params.metadata === 'object' && params.metadata ? params.metadata as Record<string, unknown> : {} }));
  }

  if (request.method === 'memory.write' || request.method === 'memory.revise' || request.method === 'write_memory' || request.method === 'revise_memory' || request.method === 'memory.replication.apply') {
    const params = request.params ?? {};
    const principalId = typeof params.principal_id === 'string' && params.principal_id.length > 0
      ? params.principal_id
      : undefined;
    const namespace = typeof params.namespace === 'string' && params.namespace.length > 0
      ? params.namespace
      : undefined;
    const subjectKey = typeof params.subject_key === 'string' && params.subject_key.length > 0
      ? params.subject_key
      : undefined;
    if (!principalId || !namespace || !subjectKey) {
      return rpcError(request.id, -32602, 'Invalid params: "principal_id", "namespace", and "subject_key" are required.');
    }
    const payload = typeof params.payload === 'object' && params.payload !== null
      ? params.payload as Record<string, unknown>
      : { value: params.payload };
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    const writeInput = {
      principalId,
      namespace,
      subjectKey,
      memoryType: typeof params.memory_type === 'string' ? params.memory_type as any : 'fact',
      payload,
      confidence: typeof params.confidence === 'number' ? params.confidence : 0.5,
      evidence: Array.isArray(params.evidence) ? params.evidence as any[] : undefined,
      validToMs: typeof params.valid_to_ms === 'number' ? params.valid_to_ms : undefined,
      memoryId: typeof params.memory_id === 'string' ? params.memory_id : undefined,
      versionId: typeof params.version_id === 'string' ? params.version_id : undefined,
      idempotencyKey: typeof params.idempotency_key === 'string' ? params.idempotency_key : undefined,
    };
    const result = service.writeMemory(writeInput);
    if (!result.ok || request.method === 'memory.replication.apply') return rpcResult(request.id, result);
    const replication = await replicateMemoryWrite(loadConfig(rootDir).memory?.replication, {
      ...writeInput,
      memoryId: result.memoryId,
      versionId: result.versionId,
      idempotencyKey: writeInput.idempotencyKey ?? `replica:${result.versionId}`,
    });
    return rpcResult(request.id, { ...result, replication });
  }

  if (request.method === 'memory.query' || request.method === 'query_memory') {
    const params = request.params ?? {};
    const namespace = typeof params.namespace === 'string' && params.namespace.length > 0
      ? params.namespace
      : undefined;
    const subjectKey = typeof params.subject_key === 'string' && params.subject_key.length > 0
      ? params.subject_key
      : undefined;
    if (!namespace || !subjectKey) {
      return rpcError(request.id, -32602, 'Invalid params: "namespace" and "subject_key" are required.');
    }
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.queryMemory({
      namespace,
      subjectKey,
      memoryType: typeof params.memory_type === 'string' ? params.memory_type as any : undefined,
      limit: typeof params.limit === 'number' ? params.limit : undefined,
      nowMs: typeof params.now_ms === 'number' ? params.now_ms : undefined,
      principalId: typeof params.principal_id === 'string' ? params.principal_id : undefined,
      requireEvidence: params.require_evidence === true || loadConfig(rootDir).memory?.requireEvidenceByDefault === true,
      includeExpired: params.include_expired === true,
      includeSuperseded: params.include_superseded === true,
      semanticQuery: typeof params.semantic_query === 'string' ? params.semantic_query : undefined,
    }));
  }

  if (request.method === 'memory.revoke_principal') {
    const params = request.params ?? {};
    const principalId = typeof params.principal_id === 'string' && params.principal_id.length > 0
      ? params.principal_id
      : undefined;
    if (!principalId) {
      return rpcError(request.id, -32602, 'Invalid params: "principal_id" is required.');
    }
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.revokePrincipal({ principalId, reason: typeof params.reason === 'string' ? params.reason : undefined, nowMs: typeof params.now_ms === 'number' ? params.now_ms : undefined }));
  }

  if (request.method === 'memory.expire') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.expireMemory({ nowMs: typeof request.params?.now_ms === 'number' ? request.params.now_ms : undefined }));
  }

  if (request.method === 'memory.conflicts') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.listConflicts({
      versionId: typeof request.params?.version_id === 'string' ? request.params.version_id : undefined,
      includeResolved: request.params?.include_resolved === true,
    }));
  }

  if (request.method === 'memory.resolve_conflict' || request.method === 'resolve_memory_conflict') {
    const params = request.params ?? {};
    const leftVersionId = typeof params.left_version_id === 'string' ? params.left_version_id : undefined;
    const rightVersionId = typeof params.right_version_id === 'string' ? params.right_version_id : undefined;
    if (!leftVersionId || !rightVersionId) {
      return rpcError(request.id, -32602, 'Invalid params: "left_version_id" and "right_version_id" are required.');
    }
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.resolveConflict({
      leftVersionId,
      rightVersionId,
      conflictType: typeof params.conflict_type === 'string' ? params.conflict_type : undefined,
      winnerVersionId: typeof params.winner_version_id === 'string' ? params.winner_version_id : undefined,
    }));
  }

  if (request.method === 'memory.compact' || request.method === 'compact_memory') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.compactMemory({ nowMs: typeof request.params?.now_ms === 'number' ? request.params.now_ms : undefined, retentionMs: typeof request.params?.retention_ms === 'number' ? request.params.retention_ms : undefined }));
  }

  if (request.method === 'memory.backfill') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.backfillLegacyA2AMemory());
  }

  if (request.method === 'memory.migration_report') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.getMigrationReport());
  }

  if (request.method === 'memory.metrics') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.getMetrics());
  }

  if (request.method === 'memory.feedback') {
    const params = request.params ?? {};
    if (typeof params.version_id !== 'string' || typeof params.relevance !== 'number') {
      return rpcError(request.id, -32602, 'Invalid params: "version_id" and numeric "relevance" are required.');
    }
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    service.recordFeedback({ versionId: params.version_id, relevance: params.relevance, principalId: typeof params.principal_id === 'string' ? params.principal_id : undefined });
    return rpcResult(request.id, { ok: true });
  }

  if (request.method === 'memory.affected') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.listAffectedMemories({
      sourceType: typeof request.params?.source_type === 'string' ? request.params.source_type : undefined,
      sourceRef: typeof request.params?.source_ref === 'string' ? request.params.source_ref : undefined,
      sourceHash: typeof request.params?.source_hash === 'string' ? request.params.source_hash : undefined,
      limit: typeof request.params?.limit === 'number' ? request.params.limit : undefined,
    }));
  }

  if (request.method === 'memory.sync_provenance') {
    const params = request.params ?? {};
    const db = await GraphDB.open(getDbPath(rootDir));
    return rpcResult(request.id, syncProvenance(db, rootDir, {
      maxDepth: typeof params.max_depth === 'number' ? params.max_depth : undefined,
      dryRun: params.dry_run === true,
      reason: typeof params.reason === 'string' ? params.reason : undefined,
    }));
  }

  if (request.method === 'memory.revalidate') {
    const params = request.params ?? {};
    const versionId = typeof params.version_id === 'string' && params.version_id.length > 0
      ? params.version_id
      : undefined;
    if (!versionId) {
      return rpcError(request.id, -32602, 'Invalid params: "version_id" is required.');
    }
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.revalidateMemory({ versionId, reason: typeof params.reason === 'string' ? params.reason : undefined }));
  }

  if (request.method === 'memory.auto_resolve') {
    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    return rpcResult(request.id, service.autoResolveConflicts({ minimumMargin: typeof request.params?.minimum_margin === 'number' ? request.params.minimum_margin : undefined }));
  }

  if (request.method === 'register_agent') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    const claim = typeof params.claim === 'string' && params.claim.length > 0
      ? params.claim
      : undefined;
    const signature = typeof params.signature === 'string' && params.signature.length > 0
      ? params.signature
      : undefined;
    const publicKey = typeof params.public_key === 'string' && params.public_key.length > 0
      ? params.public_key
      : undefined;

    if (!agentId || !claim || !signature || !publicKey) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id", "claim", "signature", and "public_key" are required.');
    }

    const verified = verifyEd25519Claim(claim, signature, publicKey);
    if (!verified) {
      return rpcError(request.id, -32003, 'Signature verification failed for agent claim.');
    }

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      if (isMemoryServiceEnabled(rootDir)) {
        new MemoryService(db).registerPrincipal({
          principalId: agentId,
          trustTier: 'trusted',
          expiresAtMs: (() => {
            const ttl = getConfiguredRegistrationTtl(rootDir, params);
            return ttl ? nowMs + ttl : undefined;
          })(),
          metadata: { source: 'a2a-registration' },
        });
      }
      const payload = {
        agent_id: agentId,
        public_key: publicKey,
        claim,
        signature,
        verified_at: new Date().toISOString(),
        trust_status: 'verified',
        expires_at: (() => {
          const ttl = getConfiguredRegistrationTtl(rootDir, params);
          return ttl ? new Date(nowMs + ttl).toISOString() : undefined;
        })(),
      };
      const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const file = db.upsertFile(agentNodePath(), hash, 'a2a', JSON.stringify(payload).length, Date.now(), true);
      const nodeId = db.insertNode(
        file.id,
        agentId,
        agentQName(agentId),
        'variable',
        1,
        1,
        'agent_registration',
        JSON.stringify(payload),
        true,
      );
      db.save();
      return rpcResult(request.id, {
        agent_id: agentId,
        registered: true,
        trust_status: 'verified',
        expires_at: payload.expires_at ?? null,
        node_id: nodeId,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'revoke_agent') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    const reason = typeof params.reason === 'string' && params.reason.length > 0
      ? params.reason
      : 'manual_revocation';

    if (!agentId) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id" is required.');
    }

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const existing = db.findNodeByQName(agentQName(agentId));
      if (!existing) {
        return rpcError(request.id, -32001, `Agent not found: ${agentId}`);
      }

      const existingDoc = existing.doc ? JSON.parse(existing.doc) as Record<string, unknown> : {};
      const revokedPayload = {
        ...existingDoc,
        agent_id: agentId,
        trust_status: 'revoked',
        revoked_at: new Date(nowMs).toISOString(),
        revoked_reason: reason,
      };
      db.insertNode(
        existing.file_id,
        agentId,
        agentQName(agentId),
        existing.kind,
        existing.start_line,
        existing.end_line,
        existing.signature,
        JSON.stringify(revokedPayload),
        true,
      );
      db.save();

      if (isMemoryServiceEnabled(rootDir)) {
        new MemoryService(db).revokePrincipal({ principalId: agentId, reason, nowMs });
      }

      return rpcResult(request.id, {
        agent_id: agentId,
        revoked: true,
        trust_status: 'revoked',
        revoked_at: revokedPayload.revoked_at,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'write_node') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    const nodeName = typeof params.name === 'string' && params.name.length > 0
      ? params.name
      : undefined;

    if (!agentId || !nodeName) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id" and "name" are required.');
    }

    const kind = typeof params.kind === 'string' && params.kind.length > 0
      ? params.kind
      : 'variable';
    const exported = params.exported === true;
    const filePath = typeof params.file_path === 'string' && params.file_path.length > 0
      ? params.file_path
      : `a2a/${agentId}/${Date.now()}-${crypto.randomUUID()}.json`;
    const qname = typeof params.qualified_name === 'string' && params.qualified_name.length > 0
      ? params.qualified_name
      : `${filePath}::${nodeName}`;

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const trustPolicy = getTrustPolicy(rootDir, params);
      const hashSeed = JSON.stringify({ agentId, nodeName, qname, ts: Date.now() });
      const hash = crypto.createHash('sha256').update(hashSeed).digest('hex');
      const upserted = db.upsertFile(filePath, hash, 'a2a', hashSeed.length, Date.now(), true);
      const nodeId = db.insertNode(
        upserted.id,
        nodeName,
        qname,
        kind,
        typeof params.start_line === 'number' ? params.start_line : 1,
        typeof params.end_line === 'number' ? params.end_line : 1,
        typeof params.signature === 'string' ? params.signature : null,
        typeof params.doc === 'string' ? params.doc : null,
        exported,
      );

      const parentQName = typeof params.parent_qname === 'string' && params.parent_qname.length > 0
        ? params.parent_qname
        : undefined;
      const registeredAgent = db.findNodeByQName(agentQName(agentId));
      const trustState = registeredAgent
        ? parseAgentTrust(registeredAgent.doc, nowMs)
        : { trustStatus: 'unverified' as const };
      let trustStatus = trustState.trustStatus;
      let trustModeApplied: TrustMode = trustPolicy.mode;
      let fallbackTriggered = false;
      let verifyLatencyMs = 0;

      if (trustPolicy.mode === 'per_write') {
        const inlineClaim = typeof params.claim === 'string' && params.claim.length > 0
          ? params.claim
          : undefined;
        const inlineSignature = typeof params.signature === 'string' && params.signature.length > 0
          ? params.signature
          : undefined;
        const inlinePublicKey = typeof params.public_key === 'string' && params.public_key.length > 0
          ? params.public_key
          : undefined;

        if (!inlineClaim || !inlineSignature || !inlinePublicKey) {
          return rpcError(request.id, -32602, 'Invalid params: per_write trust mode requires "claim", "signature", and "public_key".');
        }

        const verifyStart = Date.now();
        const verified = verifyEd25519Claim(inlineClaim, inlineSignature, inlinePublicKey);
        verifyLatencyMs = Date.now() - verifyStart;

        if (!verified) {
          return rpcError(request.id, -32003, 'Signature verification failed for write_node in per_write mode.');
        }

        trustStatus = 'verified';

        if (verifyLatencyMs > trustPolicy.maxVerifyLatencyMs && trustPolicy.allowFallback) {
          fallbackTriggered = true;
          trustModeApplied = 'registration_only';
          trustStatus = registeredAgent ? parseAgentTrust(registeredAgent.doc, nowMs).trustStatus : 'unverified';
        }
      }

      if (parentQName) {
        const parent = db.findNodeByQName(parentQName);
        if (parent) {
          db.insertEdge(parent.id, nodeId, 'references', parseCost(params.cost));
        }
      }

      if (registeredAgent) {
        db.insertEdge(registeredAgent.id, nodeId, 'authored');
      }

      if (isMemoryServiceEnabled(rootDir)) {
        const memoryService = new MemoryService(db);
        let memoryResult = memoryService.writeMemory({
          principalId: agentId,
          namespace: 'a2a-compatibility',
          subjectKey: qname,
          memoryType: 'observation',
          payload: {
            name: nodeName,
            kind,
            doc: typeof params.doc === 'string' ? params.doc : null,
            qualified_name: qname,
          },
          confidence: trustStatus === 'verified' ? 0.9 : 0.5,
          evidence: [{ sourceType: 'legacy_a2a_write', sourceRef: filePath }],
        });
        if (!memoryResult.ok && memoryResult.error?.startsWith('Unknown principal') && trustStatus === 'verified') {
          memoryService.registerPrincipal({
            principalId: agentId,
            trustTier: 'trusted',
            metadata: { source: 'a2a-per-write-verification' },
          });
          memoryResult = memoryService.writeMemory({
            principalId: agentId,
            namespace: 'a2a-compatibility',
            subjectKey: qname,
            memoryType: 'observation',
            payload: { name: nodeName, kind, doc: typeof params.doc === 'string' ? params.doc : null, qualified_name: qname },
            confidence: 0.9,
            evidence: [{ sourceType: 'legacy_a2a_write', sourceRef: filePath }],
          });
        }
        if (!memoryResult.ok && trustStatus === 'verified') {
          return rpcError(request.id, -32004, memoryResult.error ?? 'Persistent-memory compatibility write failed.');
        }
      }

      db.save();
      return rpcResult(request.id, {
        node_id: nodeId,
        file_path: filePath,
        qualified_name: qname,
        agent_id: agentId,
        trust_status: trustStatus,
        trust_mode_applied: trustModeApplied,
        verify_latency_ms: verifyLatencyMs,
        fallback_triggered: fallbackTriggered,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'read_lineage') {
    const params = request.params ?? {};
    const query = typeof params.qualified_name === 'string' && params.qualified_name.length > 0
      ? params.qualified_name
      : (typeof params.name === 'string' && params.name.length > 0 ? params.name : undefined);
    if (!query) {
      return rpcError(request.id, -32602, 'Invalid params: "qualified_name" or "name" is required.');
    }

    const maxDepth = typeof params.max_depth === 'number' ? params.max_depth : 3;
    const maxNodes = typeof params.max_nodes === 'number' ? params.max_nodes : 50;

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const startNode = findNodeByQuery(db, query);
      if (!startNode) {
        return rpcError(request.id, -32001, `Node not found: ${query}`);
      }

      const visited = new Set<number>([startNode.id]);
      const queue: Array<{ id: number; depth: number }> = [{ id: startNode.id, depth: 0 }];
      const nodes: Array<{ id: number; qualified_name: string; name: string; kind: string; file_path: string; depth: number; doc: string | null }> = [];
      const edges: Array<{ source_id: number; target_id: number; kind: string }> = [];

      while (queue.length > 0 && nodes.length < maxNodes) {
        const current = queue.shift();
        if (!current) break;
        const record = db.getNode(current.id);
        if (!record) continue;

        nodes.push({
          id: record.id,
          qualified_name: record.qualified_name,
          name: record.name,
          kind: record.kind,
          file_path: getFilePathForNode(db, record),
          depth: current.depth,
          doc: record.doc,
        });

        if (current.depth >= maxDepth) continue;

        const incoming = db.getEdgesTo(record.id);
        for (const edge of incoming) {
          const sourceNode = db.getNode(edge.source_id);
          if (!sourceNode) continue;
          edges.push({ source_id: edge.source_id, target_id: edge.target_id, kind: edge.kind });
          if (!visited.has(sourceNode.id)) {
            visited.add(sourceNode.id);
            queue.push({ id: sourceNode.id, depth: current.depth + 1 });
          }
        }
      }

      return rpcResult(request.id, {
        target: startNode.qualified_name,
        max_depth: maxDepth,
        max_nodes: maxNodes,
        nodes,
        edges,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'query_by_agent') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    if (!agentId) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id" is required.');
    }

    const limit = typeof params.limit === 'number' ? params.limit : 100;
    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const registration = db.findNodeByQName(agentQName(agentId));
      const authoredNodes: Array<{ id: number; name: string; qualified_name: string; kind: string; file_path: string; doc: string | null }> = [];

      if (registration) {
        const authoredEdges = db.getEdgesFrom(registration.id, 'authored');
        for (const edge of authoredEdges.slice(0, limit)) {
          const node = db.getNode(edge.target_id);
          if (!node) continue;
          authoredNodes.push({
            id: node.id,
            name: node.name,
            qualified_name: node.qualified_name,
            kind: node.kind,
            file_path: getFilePathForNode(db, node),
            doc: node.doc,
          });
        }
      }

      return rpcResult(request.id, {
        agent_id: agentId,
        registration_found: Boolean(registration),
        registration_status: registration ? parseAgentTrust(registration.doc, nowMs).trustStatus : 'unverified',
        count: authoredNodes.length,
        nodes: authoredNodes,
      });
    } finally {
      db.close();
    }
  }

  return rpcError(request.id, -32601, `Method not found: ${request.method}`);
}

export async function readJsonBody(req: http.IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<any> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function startA2AServer(rootDir: string, opts: { port?: number; host?: string } = {}): http.Server {
  const port = opts.port ?? 7071;
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/.well-known/agent-card.json') {
        const card = getAgentCard();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(card));
        return;
      }

      if (req.method === 'POST' && url === '/rpc') {
        const maxBodyBytes = getConfiguredBodyLimit(rootDir);
        const payload = await readJsonBody(req, maxBodyBytes);
        const response = await handleA2ARpcRequest(rootDir, payload as A2ARpcRequest, {
          headers: req.headers,
          clientKey: req.socket.remoteAddress ?? 'unknown',
          nowMs: Date.now(),
        });
        const statusCode = response.error?.code === -32029 ? 429 : 200;
        res.writeHead(statusCode, statusCode === 429
          ? { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' }
          : { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      const statusCode = err?.message === 'Request body too large' ? 413 : 500;
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message ?? 'Internal server error' }));
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(JSON.stringify({
      status: 'a2a_listening',
      host,
      port,
      card_url: `http://${host}:${port}/.well-known/agent-card.json`,
      rpc_url: `http://${host}:${port}/rpc`,
    }) + '\n');
  });

  return server;
}
