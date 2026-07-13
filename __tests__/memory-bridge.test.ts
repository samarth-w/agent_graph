import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleA2ARpcRequest } from '../src/a2a';
import { GraphDB } from '../src/storage';
import { MemoryService } from '../src/memory';
import { getDbPath } from '../src/config';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-memory-bridge-'));
}

describe('MCP/A2A persistent-memory bridge', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const rootDir = tempDirs.pop()!;
      MemoryService.closeForGraphPath(getDbPath(rootDir));
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('uses equivalent canonical semantics through the A2A adapter and MemoryService', async () => {
    const rootDir = createTempDir();
    tempDirs.push(rootDir);
    const registered = await handleA2ARpcRequest(rootDir, {
      jsonrpc: '2.0', id: 1, method: 'register_memory_principal',
      params: { principal_id: 'agent.bridge', trust_tier: 'trusted' },
    });
    expect(registered.error).toBeUndefined();

    const write = await handleA2ARpcRequest(rootDir, {
      jsonrpc: '2.0', id: 2, method: 'write_memory',
      params: {
        principal_id: 'agent.bridge', namespace: 'workspace', subject_key: 'bridge',
        memory_type: 'fact', payload: { shared: true }, confidence: 0.9,
        evidence: [{ sourceType: 'test', sourceRef: 'a2a' }],
      },
    });
    expect(write.error).toBeUndefined();

    const db = await GraphDB.open(getDbPath(rootDir));
    const service = new MemoryService(db);
    const nowMs = Date.now();
    const direct = service.queryMemory({
      namespace: 'workspace', subjectKey: 'bridge', principalId: 'agent.bridge', requireEvidence: true, nowMs,
    });
    const throughA2A = await handleA2ARpcRequest(rootDir, {
      jsonrpc: '2.0', id: 3, method: 'query_memory',
      params: {
        principal_id: 'agent.bridge', namespace: 'workspace', subject_key: 'bridge', require_evidence: true, now_ms: nowMs,
      },
    });
    expect(throughA2A.error).toBeUndefined();
    const result = throughA2A.result as any;
    expect(result.results[0].versionId).toBe(direct.results[0].versionId);
    expect(result.results[0].scoreComponents).toEqual(direct.results[0].scoreComponents);
  });
});
