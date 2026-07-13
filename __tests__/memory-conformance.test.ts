import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolHandler } from '../src/mcp';
import { handleA2ARpcRequest } from '../src/a2a';
import { getDbPath } from '../src/config';
import { MemoryService } from '../src/memory';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-memory-conformance-'));
}

describe('persistent-memory MCP/A2A conformance', () => {
  let tempDir: string;
  let handler: ToolHandler;

  beforeEach(() => {
    tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({
      memory: {
        defaultDenyNamespaceAccess: true,
        allowUnverifiedWrites: false,
      },
    }));
    handler = new ToolHandler(tempDir);
  });

  afterEach(() => {
    handler.close();
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps deterministic query ordering between MCP and A2A for equivalent operations', async () => {
    const principal = 'agent.conformance';
    const nowMs = Date.now();

    const registered = await handler.execute('cgraph_memory_register_principal', {
      principalId: principal,
      trustTier: 'trusted',
      namespaces: 'workspace',
    });
    expect(registered.isError).not.toBe(true);

    const writeOne = await handler.execute('cgraph_memory_write', {
      principalId: principal,
      namespace: 'workspace',
      subjectKey: 'ordering',
      memoryType: 'fact',
      payload: { label: 'low-confidence' },
      confidence: 0.2,
      idempotencyKey: 'one',
      format: 'json',
    });
    const one = JSON.parse(writeOne.content[0].text) as { memoryId: string; versionId: string };

    const writeTwo = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'a2a-write',
      method: 'write_memory',
      params: {
        principal_id: principal,
        namespace: 'workspace',
        subject_key: 'ordering',
        memory_type: 'fact',
        payload: { label: 'high-confidence' },
        confidence: 0.95,
        memory_id: `${one.memoryId}-2`,
        idempotency_key: 'two',
      },
    });
    expect(writeTwo.error).toBeUndefined();

    const mcpQuery = await handler.execute('cgraph_memory_query', {
      namespace: 'workspace',
      subjectKey: 'ordering',
      principalId: principal,
      includeSuperseded: true,
      nowMs,
      format: 'json',
    });
    const mcpPayload = JSON.parse(mcpQuery.content[0].text) as { results: Array<{ versionId: string }> };

    const a2aQuery = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'a2a-query',
      method: 'query_memory',
      params: {
        principal_id: principal,
        namespace: 'workspace',
        subject_key: 'ordering',
        include_superseded: true,
        now_ms: nowMs,
      },
    });
    expect(a2aQuery.error).toBeUndefined();
    const a2aPayload = a2aQuery.result as { results: Array<{ versionId: string }> };
    expect(mcpPayload.results.map(r => r.versionId)).toEqual(a2aPayload.results.map(r => r.versionId));
  });

  it('enforces namespace ACL and unverified write policy consistently', async () => {
    await handler.execute('cgraph_memory_register_principal', {
      principalId: 'agent.unverified',
      trustTier: 'unverified',
      namespaces: 'workspace',
    });

    const blockedWrite = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'blocked',
      method: 'write_memory',
      params: {
        principal_id: 'agent.unverified',
        namespace: 'workspace',
        subject_key: 'policy',
        payload: { x: 1 },
      },
    });
    expect(blockedWrite.error).toBeUndefined();
    expect((blockedWrite.result as { ok: boolean }).ok).toBe(false);

    const deniedNamespace = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'denied',
      method: 'query_memory',
      params: {
        principal_id: 'agent.unverified',
        namespace: 'global',
        subject_key: 'policy',
      },
    });
    expect(deniedNamespace.error).toBeUndefined();
    const payload = deniedNamespace.result as { total: number };
    expect(payload.total).toBe(0);
  });

  it('keeps principal expiry and revocation semantics identical across adapters', async () => {
    const expiredAt = Date.now() - 1;
    const registration = await handler.execute('cgraph_memory_register_principal', {
      principalId: 'agent.expired', trustTier: 'trusted', namespaces: 'workspace', expiresAtMs: expiredAt,
    });
    expect(JSON.parse(registration.content[0].text).status).toBe('expired');

    const expiredWrite = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0', id: 'expired-write', method: 'write_memory', params: {
        principal_id: 'agent.expired', namespace: 'workspace', subject_key: 'expiry', payload: { value: 1 },
      },
    });
    expect((expiredWrite.result as { ok: boolean }).ok).toBe(false);

    await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0', id: 'register-revoked', method: 'register_memory_principal', params: {
        principal_id: 'agent.revoked', trust_tier: 'trusted', metadata: { namespaces: ['workspace'] },
      },
    });
    const revoked = await handler.execute('cgraph_memory_revoke_principal', {
      principalId: 'agent.revoked', reason: 'conformance', nowMs: expiredAt,
    });
    expect(JSON.parse(revoked.content[0].text).status).toBe('revoked');

    const revokedWrite = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0', id: 'revoked-write', method: 'write_memory', params: {
        principal_id: 'agent.revoked', namespace: 'workspace', subject_key: 'revocation', payload: { value: 2 },
      },
    });
    expect((revokedWrite.result as { ok: boolean }).ok).toBe(false);
  });

  it('conforms on conflicts, resolution, and expiry across MCP and A2A', async () => {
    const principal = 'agent.lifecycle';
    await handler.execute('cgraph_memory_register_principal', {
      principalId: principal, trustTier: 'trusted', namespaces: 'workspace',
    });
    const leftResult = await handler.execute('cgraph_memory_write', {
      principalId: principal, namespace: 'workspace', subjectKey: 'conflict', memoryId: 'left-memory',
      payload: { decision: true }, format: 'json',
    });
    const left = JSON.parse(leftResult.content[0].text) as { versionId: string };
    const rightResult = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0', id: 'right', method: 'write_memory', params: {
        principal_id: principal, namespace: 'workspace', subject_key: 'conflict', memory_id: 'right-memory', payload: { decision: false },
      },
    });
    const right = rightResult.result as { versionId: string };

    const mcpConflicts = await handler.execute('cgraph_memory_conflicts', {});
    const a2aConflicts = await handleA2ARpcRequest(tempDir, { jsonrpc: '2.0', id: 'conflicts', method: 'memory.conflicts' });
    const mcpConflictPayload = JSON.parse(mcpConflicts.content[0].text) as Array<{ leftVersionId: string; rightVersionId: string }>;
    expect(mcpConflictPayload).toHaveLength(1);
    expect((a2aConflicts.result as unknown[])).toHaveLength(mcpConflictPayload.length);

    const resolved = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0', id: 'resolve', method: 'resolve_memory_conflict', params: {
        left_version_id: left.versionId, right_version_id: right.versionId, winner_version_id: right.versionId,
      },
    });
    expect((resolved.result as { resolutionState: string }).resolutionState).toBe('winner_selected');
    expect(JSON.parse((await handler.execute('cgraph_memory_conflicts', {})).content[0].text)).toHaveLength(0);

    await handler.execute('cgraph_memory_write', {
      principalId: principal, namespace: 'workspace', subjectKey: 'expired', payload: { stale: true }, validToMs: Date.now() - 1,
    });
    await handleA2ARpcRequest(tempDir, { jsonrpc: '2.0', id: 'expire', method: 'memory.expire', params: { now_ms: Date.now() } });
    const mcpQuery = await handler.execute('cgraph_memory_query', {
      namespace: 'workspace', subjectKey: 'expired', principalId: principal, format: 'json',
    });
    const a2aQuery = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0', id: 'expired-query', method: 'query_memory', params: {
        principal_id: principal, namespace: 'workspace', subject_key: 'expired',
      },
    });
    expect(JSON.parse(mcpQuery.content[0].text).total).toBe((a2aQuery.result as { total: number }).total);
    expect((a2aQuery.result as { total: number }).total).toBe(0);
  });
});
