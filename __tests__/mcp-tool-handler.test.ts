/**
 * ToolHandler integration tests — exercises the MCP dispatch/execute path
 * directly against a seeded graph database (no stdio transport needed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { getDbPath } from '../src/config';
import { MemoryService } from '../src/memory';
import { ToolHandler } from '../src/mcp';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-mcp-handler-test-'));
}

async function seedDb(tempDir: string): Promise<void> {
  const dbPath = getDbPath(tempDir);
  const db = await GraphDB.open(dbPath);

  const srcDir = path.join(tempDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'demo.ts'), 'function alpha() {}\nfunction beta() {}\n');

  const fileId = db.upsertFile('src/demo.ts', 'h1', 'typescript', 100, 1000).id;
  const idA = db.insertNode(fileId, 'alpha', 'src/demo.ts::alpha', 'function', 1, 1, 'function alpha()', null, true);
  const idB = db.insertNode(fileId, 'beta', 'src/demo.ts::beta', 'function', 2, 2, 'function beta()', null, false);
  db.insertEdge(idA, idB, 'calls');
  db.close();
}

describe('ToolHandler.execute', () => {
  let tempDir: string;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = createTempDir();
    await seedDb(tempDir);
    handler = new ToolHandler(tempDir);
  });

  afterEach(() => {
    handler.close();
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an error for an unknown tool', async () => {
    const result = await handler.execute('cgraph_nonexistent', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('returns a validation error when a required arg is missing', async () => {
    const result = await handler.execute('cgraph_search', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query must be a non-empty string');
  });

  it('cgraph_search finds a seeded symbol', async () => {
    const result = await handler.execute('cgraph_search', { query: 'alpha' });
    expect(result.content[0].text).toContain('alpha');
  });

  it('cgraph_search reports no results for an unknown query', async () => {
    const result = await handler.execute('cgraph_search', { query: 'nope_xyz' });
    expect(result.content[0].text).toContain('No results for');
  });

  it('cgraph_node returns detail for a known symbol', async () => {
    const result = await handler.execute('cgraph_node', { symbol: 'alpha' });
    expect(result.content[0].text).toContain('alpha');
  });

  it('cgraph_node reports missing symbol', async () => {
    const result = await handler.execute('cgraph_node', { symbol: 'missing_symbol' });
    expect(result.content[0].text).toContain('not found');
  });

  it('cgraph_callers finds callers of beta', async () => {
    const result = await handler.execute('cgraph_callers', { symbol: 'beta' });
    expect(result.content[0].text).toContain('alpha');
  });

  it('cgraph_callees finds callees of alpha', async () => {
    const result = await handler.execute('cgraph_callees', { symbol: 'alpha' });
    expect(result.content[0].text).toContain('beta');
  });

  it('cgraph_impact returns compressed impact data', async () => {
    const result = await handler.execute('cgraph_impact', { symbol: 'beta' });
    expect(result.content[0].text).toContain('ccr_id');
  });

  it('cgraph_files lists indexed files', async () => {
    const result = await handler.execute('cgraph_files', {});
    expect(result.content[0].text).toContain('demo.ts');
  });

  it('cgraph_status reports index counts', async () => {
    const result = await handler.execute('cgraph_status', {});
    expect(result.content[0].text).toContain('Total nodes');
  });

  it('cgraph_deadcode reports no dead code for a fully connected graph', async () => {
    const result = await handler.execute('cgraph_deadcode', {});
    expect(result.content[0].text).toBeTruthy();
  });

  it('cgraph_cycles reports no cycles', async () => {
    const result = await handler.execute('cgraph_cycles', {});
    expect(result.content[0].text).toContain('No circular dependencies detected.');
  });

  it('cgraph_stats returns project metrics', async () => {
    const result = await handler.execute('cgraph_stats', {});
    expect(result.content[0].text).toContain('Project Metrics');
  });

  it('cgraph_dna returns codebase DNA summary', async () => {
    const result = await handler.execute('cgraph_dna', {});
    expect(result.content[0].text).toContain('Codebase DNA');
  });

  it('cgraph_lint reports no rules configured', async () => {
    const result = await handler.execute('cgraph_lint', {});
    expect(result.content[0].text).toContain('No architecture rules defined');
  });

  it('cgraph_validate_plan requires symbols or files', async () => {
    const result = await handler.execute('cgraph_validate_plan', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide symbols or files');
  });

  it('cgraph_validate_plan validates a plan for a known symbol', async () => {
    const result = await handler.execute('cgraph_validate_plan', { symbols: 'alpha' });
    expect(result.content[0].text).toContain('Plan Validation');
  });

  it('cgraph_export produces a mermaid diagram by default', async () => {
    const result = await handler.execute('cgraph_export', {});
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('cgraph_export rejects an invalid format', async () => {
    const result = await handler.execute('cgraph_export', { format: 'bogus' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid format');
  });

  it('cgraph_intent_search finds symbols by natural language', async () => {
    const result = await handler.execute('cgraph_intent_search', { query: 'alpha' });
    expect(result.content[0].text).toBeTruthy();
  });

  it('cgraph_auto_context returns symbols for a known file', async () => {
    const result = await handler.execute('cgraph_auto_context', { file: 'src/demo.ts' });
    expect(result.content[0].text).toContain('alpha');
  });

  it('cgraph_suggest returns a message when there are no suggestions', async () => {
    const result = await handler.execute('cgraph_suggest', {});
    expect(result.content[0].text).toBeTruthy();
  });

  it('cgraph_retrieve_ccr reports missing data for an unknown id', async () => {
    const result = await handler.execute('cgraph_retrieve_ccr', { ccr_id: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found or expired');
  });

  it('cgraph_retrieve_ccr retrieves data saved by a prior compressed call', async () => {
    const impactResult = await handler.execute('cgraph_impact', { symbol: 'beta' });
    const parsed = JSON.parse(impactResult.content[0].text);
    const ccrId = parsed.meta.ccr_id;

    const retrieved = await handler.execute('cgraph_retrieve_ccr', { ccr_id: ccrId });
    expect(retrieved.isError).toBeFalsy();
    expect(retrieved.content[0].text.length).toBeGreaterThan(0);
  });

  it('caches deterministic tool results for identical args', async () => {
    const first = await handler.execute('cgraph_search', { query: 'alpha' });
    const second = await handler.execute('cgraph_search', { query: 'alpha' });
    expect(second.content[0].text).toBe(first.content[0].text);
  });

  it('supports memory write/query tools with deterministic JSON output', async () => {
    await handler.execute('cgraph_memory_register_principal', {
      principalId: 'agent.mcp.memory',
      trustTier: 'trusted',
      namespaces: 'workspace',
    });

    const write = await handler.execute('cgraph_memory_write', {
      principalId: 'agent.mcp.memory',
      namespace: 'workspace',
      subjectKey: 'mcp-memory',
      payload: { hello: 'world' },
      idempotencyKey: 'mcp-memory-write',
      format: 'json',
    });
    const writeJson = JSON.parse(write.content[0].text) as { ok: boolean; versionId: string };
    expect(writeJson.ok).toBe(true);

    const query = await handler.execute('cgraph_memory_query', {
      namespace: 'workspace',
      subjectKey: 'mcp-memory',
      principalId: 'agent.mcp.memory',
      nowMs: Date.now(),
      format: 'json',
    });
    const queryJson = JSON.parse(query.content[0].text) as { total: number; results: Array<{ versionId: string }> };
    expect(queryJson.total).toBeGreaterThanOrEqual(1);
    expect(queryJson.results[0].versionId).toBe(writeJson.versionId);
  });

  it('returns migration governance report through memory migration tool', async () => {
    const report = await handler.execute('cgraph_memory_migration_report', {});
    const json = JSON.parse(report.content[0].text) as {
      totalLegacyNodes: number;
      importedLegacyRecords: number;
      parityMismatches: number;
    };
    expect(typeof json.totalLegacyNodes).toBe('number');
    expect(typeof json.importedLegacyRecords).toBe('number');
    expect(typeof json.parityMismatches).toBe('number');
  });

  it('revokes memory principals and exposes audit-derived memory metrics', async () => {
    await handler.execute('cgraph_memory_register_principal', {
      principalId: 'agent.mcp.revoked', trustTier: 'trusted', namespaces: 'workspace',
    });
    const revoke = await handler.execute('cgraph_memory_revoke_principal', {
      principalId: 'agent.mcp.revoked', reason: 'test', nowMs: 1,
    });
    expect(JSON.parse(revoke.content[0].text).status).toBe('revoked');

    const metrics = await handler.execute('cgraph_memory_metrics', {});
    const json = JSON.parse(metrics.content[0].text) as { operations: Record<string, number>; activeVersions: number };
    expect(json.operations.revoke).toBeGreaterThanOrEqual(1);
    expect(typeof json.activeVersions).toBe('number');
  });
});
