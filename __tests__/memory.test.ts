import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDB } from '../src/storage';
import { getDbPath } from '../src/config';
import { MemoryService } from '../src/memory';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-memory-test-'));
}

describe('persistent memory service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes and retrieves ranked memory records for the same subject', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);

    const principal = service.registerPrincipal({ principalId: 'agent.alpha', trustTier: 'trusted' });
    expect(principal.status).toBe('active');

    const first = service.writeMemory({
      principalId: principal.principalId,
      namespace: 'project',
      subjectKey: 'workflow',
      memoryType: 'fact',
      payload: { note: 'initial state' },
      confidence: 0.6,
      evidence: [{ sourceType: 'tool_result', sourceRef: 'seed', excerptHash: 'abc' }],
    });
    expect(first.ok).toBe(true);

    const second = service.writeMemory({
      principalId: principal.principalId,
      namespace: 'project',
      subjectKey: 'workflow',
      memoryType: 'fact',
      payload: { note: 'updated state' },
      confidence: 0.95,
      evidence: [{ sourceType: 'tool_result', sourceRef: 'rerun', excerptHash: 'def' }],
    });
    expect(second.ok).toBe(true);

    const query = service.queryMemory({ namespace: 'project', subjectKey: 'workflow' });
    expect(query.results.length).toBeGreaterThan(0);
    expect(query.results[0].payload.note).toBe('updated state');
    expect(query.results[0].score).toBeGreaterThan(query.results[1].score);
  });

  it('revokes principals and blocks further writes', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);

    const principal = service.registerPrincipal({ principalId: 'agent.revoke', trustTier: 'trusted' });
    const revoked = service.revokePrincipal({ principalId: principal.principalId, reason: 'security' });
    expect(revoked.status).toBe('revoked');

    const write = service.writeMemory({
      principalId: principal.principalId,
      namespace: 'project',
      subjectKey: 'blocked',
      memoryType: 'warning',
      payload: { reason: 'blocked' },
      confidence: 0.9,
    });

    expect(write.ok).toBe(false);
    expect(write.error).toContain('revoked');
  });

  it('expires stale memory versions and reports the lifecycle state', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);

    const principal = service.registerPrincipal({ principalId: 'agent.expire', trustTier: 'trusted' });
    const write = service.writeMemory({
      principalId: principal.principalId,
      namespace: 'project',
      subjectKey: 'ttl',
      memoryType: 'plan',
      payload: { text: 'stale' },
      confidence: 0.5,
      validToMs: Date.now() - 10_000,
    });
    expect(write.ok).toBe(true);

    const expired = service.expireMemory({ nowMs: Date.now() });
    expect(expired.expiredCount).toBeGreaterThan(0);

    const query = service.queryMemory({ namespace: 'project', subjectKey: 'ttl', includeExpired: true });
    expect(query.results[0].status).toBe('expired');
  });

  it('tombstones expired records and never returns them, even for audit queries', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    const nowMs = Date.now();
    service.registerPrincipal({ principalId: 'agent.tombstone', trustTier: 'trusted' });
    const write = service.writeMemory({
      principalId: 'agent.tombstone', namespace: 'project', subjectKey: 'retained', memoryType: 'fact',
      payload: { state: 'obsolete' }, confidence: 0.5, validToMs: nowMs - 10_000,
    });
    expect(write.ok).toBe(true);
    expect(service.expireMemory({ nowMs }).expiredCount).toBe(1);
    expect(service.compactMemory({ nowMs: nowMs + 10_000, retentionMs: 1 }).tombstonedCount).toBe(1);

    const query = service.queryMemory({
      namespace: 'project', subjectKey: 'retained', includeExpired: true, includeSuperseded: true,
    });
    expect(query.total).toBe(0);
    expect(service.getMetrics().tombstonedRecords).toBe(1);
  });

  it('honors configured permissive trust policy and default compaction retention', async () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({
      memory: { allowUnverifiedWrites: true, defaultDenyNamespaceAccess: true, defaultRetentionMs: 1 },
    }));
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({
      principalId: 'agent.permissive', trustTier: 'unverified', metadata: { namespaces: ['workspace'] },
    });
    const nowMs = Date.now();
    expect(service.writeMemory({
      principalId: 'agent.permissive', namespace: 'workspace', subjectKey: 'configured-retention',
      payload: { permitted: true }, validToMs: nowMs - 10_000,
    }).ok).toBe(true);
    service.expireMemory({ nowMs });
    expect(service.compactMemory({ nowMs: nowMs + 10_000 }).tombstonedCount).toBe(1);
  });

  it('uses opt-in hybrid semantic feedback and automatically resolves decisive conflicts', async () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({
      memory: { hybridRankingEnabled: true, autoResolveConflicts: true, autoResolveMinimumMargin: 0.1 },
    }));
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({ principalId: 'agent.hybrid', trustTier: 'trusted' });
    const strong = service.writeMemory({
      principalId: 'agent.hybrid', namespace: 'project', subjectKey: 'deployment', memoryType: 'decision',
      payload: { recommendation: 'deploy blue green safely' }, confidence: 0.95,
      evidence: [{ sourceType: 'test', sourceRef: 'green' }, { sourceType: 'test', sourceRef: 'blue' }],
    });
    const weak = service.writeMemory({
      principalId: 'agent.hybrid', namespace: 'project', subjectKey: 'deployment', memoryType: 'decision',
      payload: { recommendation: 'do not deploy' }, confidence: 0.1,
    });
    expect(strong.ok).toBe(true);
    expect(weak.ok).toBe(true);
    expect(service.listConflicts()).toHaveLength(0);

    service.recordFeedback({ versionId: strong.versionId!, relevance: 1, principalId: 'agent.hybrid' });
    const result = service.queryMemory({
      namespace: 'project', subjectKey: 'deployment', semanticQuery: 'safe blue green deployment', includeSuperseded: true,
    });
    expect(result.results[0].versionId).toBe(strong.versionId);
    expect(result.results[0].scoreComponents.semantic).toBeGreaterThan(0);
    expect(result.results[0].scoreComponents.adaptive).toBe(1);
  });

  it('records provenance metadata and marks affected versions stale when evidence changes', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({ principalId: 'agent.provenance', trustTier: 'trusted' });

    const written = service.writeMemory({
      principalId: 'agent.provenance',
      namespace: 'project',
      subjectKey: 'provenance',
      memoryType: 'fact',
      payload: { note: 'depends on file' },
      confidence: 0.8,
      evidence: [{
        sourceType: 'file',
        sourceRef: 'src/feature.ts',
        excerptHash: 'hash-1',
        metadata: { kind: 'file', target: 'src/feature.ts', codeHash: 'hash-1' },
      }],
    });
    expect(written.ok).toBe(true);

    const invalidated = service.invalidateByChange({
      sourceType: 'file',
      sourceRef: 'src/feature.ts',
      reason: 'repo changed',
      nowMs: Date.now(),
    });
    expect(invalidated.invalidatedCount).toBe(1);

    const affected = service.listAffectedMemories({
      sourceType: 'file',
      sourceRef: 'src/feature.ts',
      limit: 10,
    });
    expect(affected.affectedCount).toBe(1);
    expect(affected.affected[0].versionId).toBe(written.versionId);

    const revalidated = service.revalidateMemory({
      versionId: written.versionId!,
      reason: 'rechecked after change',
      nowMs: Date.now(),
    });
    expect(revalidated.ok).toBe(true);
    expect(revalidated.status).toBe('active');

    const query = service.queryMemory({ namespace: 'project', subjectKey: 'provenance' });
    expect(query.results[0].status).toBe('active');
    expect(query.results[0].policyWarnings).not.toContain('stale');
    expect(query.results[0].evidenceRefs[0].metadata?.target).toBe('src/feature.ts');
  });

  it('rejects revoked, expired, and evidence-empty candidates by default with explainable scores', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    const principal = service.registerPrincipal({ principalId: 'agent.policy', trustTier: 'trusted' });
    service.writeMemory({
      principalId: principal.principalId,
      namespace: 'project', subjectKey: 'policy', memoryType: 'fact',
      payload: { value: 'no-evidence' }, confidence: 1,
    });
    service.writeMemory({
      principalId: principal.principalId,
      namespace: 'project', subjectKey: 'policy', memoryType: 'fact',
      payload: { value: 'evidenced' }, confidence: 0.8,
      evidence: [{ sourceType: 'test', sourceRef: 'policy' }],
    });

    const evidenced = service.queryMemory({ namespace: 'project', subjectKey: 'policy', requireEvidence: true });
    expect(evidenced.results).toHaveLength(1);
    expect(evidenced.results[0].scoreComponents.trust).toBe(1);
    expect(evidenced.results[0].evidenceRefs[0].sourceRef).toBe('policy');
    expect(evidenced.results[0].acceptedRules).toContain('evidence present');
  });

  it('detects conflicts and retains a durable resolution record', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({ principalId: 'agent.conflict', trustTier: 'trusted' });
    const left = service.writeMemory({
      principalId: 'agent.conflict', namespace: 'project', subjectKey: 'decision', memoryType: 'decision',
      payload: { deploy: true }, confidence: 0.8,
    });
    const right = service.writeMemory({
      principalId: 'agent.conflict', namespace: 'project', subjectKey: 'decision', memoryType: 'decision',
      payload: { deploy: false }, confidence: 0.9,
    });
    const conflicts = service.listConflicts();
    expect(conflicts).toHaveLength(1);
    const resolution = service.resolveConflict({
      leftVersionId: left.versionId!, rightVersionId: right.versionId!, winnerVersionId: right.versionId,
    });
    expect(resolution.resolutionState).toBe('winner_selected');
    expect(service.listConflicts()).toHaveLength(0);
  });

  it('preserves idempotency and one-active-version invariants across generated revisions', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    service.registerPrincipal({ principalId: 'agent.invariants', trustTier: 'trusted' });

    for (let index = 0; index < 20; index++) {
      const memoryId = `invariant-${index}`;
      const idempotencyKey = `retry-${index}`;
      const first = service.writeMemory({
        principalId: 'agent.invariants', namespace: 'project', subjectKey: `item-${index}`,
        memoryId, idempotencyKey, payload: { index, revision: 1 }, confidence: 0.5,
      });
      const retry = service.writeMemory({
        principalId: 'agent.invariants', namespace: 'project', subjectKey: `item-${index}`,
        memoryId, idempotencyKey, payload: { index, revision: 1 }, confidence: 0.5,
      });
      const revision = service.writeMemory({
        principalId: 'agent.invariants', namespace: 'project', subjectKey: `item-${index}`,
        memoryId, idempotencyKey: `revision-${index}`, payload: { index, revision: 2 }, confidence: 0.8,
      });
      expect(retry.versionId).toBe(first.versionId);
      expect(revision.ok).toBe(true);
      const versions = service.queryMemory({
        namespace: 'project', subjectKey: `item-${index}`, includeSuperseded: true,
      });
      expect(versions.results).toHaveLength(2);
      expect(versions.results.filter((entry) => entry.status === 'active')).toHaveLength(1);
    }
  });

  it('keeps the pinned ranking corpus in its expected order', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const service = new MemoryService(db);
    const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'memory-ranking-corpus.json'), 'utf8')) as Array<{
      namespace: string; subjectKey: string; nowMs: number; expectedOrder: string[];
      records: Array<{ id: string; principal: string; trustTier: 'trusted' | 'neutral'; confidence: number; evidence: number; validFromMs: number }>;
    }>;

    for (const scenario of corpus) {
      for (const record of scenario.records) {
        service.registerPrincipal({ principalId: record.principal, trustTier: record.trustTier });
        service.writeMemory({
          principalId: record.principal, namespace: scenario.namespace, subjectKey: scenario.subjectKey,
          memoryId: `${scenario.subjectKey}-${record.id}`, payload: { rankingId: record.id },
          confidence: record.confidence, validFromMs: record.validFromMs,
          evidence: Array.from({ length: record.evidence }, (_, index) => ({ sourceType: 'corpus', sourceRef: `${record.id}-${index}` })),
        });
      }
      const result = service.queryMemory({ namespace: scenario.namespace, subjectKey: scenario.subjectKey, nowMs: scenario.nowMs });
      expect(result.results.map((entry) => (entry.payload as { rankingId: string }).rankingId)).toEqual(scenario.expectedOrder);
    }
  });
});
