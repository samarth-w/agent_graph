import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDB } from '../src/storage';
import { MemoryService } from '../src/memory';
import { getDbPath } from '../src/config';
import { handleA2ARpcRequest } from '../src/a2a';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-memory-migration-'));
}

describe('persistent memory migration governance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('backfills legacy A2A nodes and reports parity metrics', async () => {
    const db = await GraphDB.open(getDbPath(tempDir));
    const payload = { agent_id: 'agent.legacy', note: 'legacy observation' };
    const file = db.upsertFile('a2a/legacy/1.json', 'legacy-hash', 'a2a', 10, Date.now(), true);
    db.insertNode(
      file.id,
      'legacyNode',
      'a2a/legacy/1.json::legacyNode',
      'variable',
      1,
      1,
      'legacy()',
      JSON.stringify(payload),
      true,
    );
    db.close();

    const service = new MemoryService(await GraphDB.open(getDbPath(tempDir)));
    const backfill = service.backfillLegacyA2AMemory();
    expect(backfill.totalLegacyNodes).toBe(1);
    expect(backfill.importedCount).toBe(1);
    expect(backfill.parityMismatches).toBe(0);

    const report = service.getMigrationReport();
    expect(report.totalLegacyNodes).toBe(1);
    expect(report.importedLegacyRecords).toBe(1);
    expect(report.parityMismatches).toBe(0);
  });

  it('exposes migration report through A2A governance method', async () => {
    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'migration-report',
      method: 'memory.migration_report',
    });
    expect(response.error).toBeUndefined();
    const report = response.result as {
      totalLegacyNodes: number;
      importedLegacyRecords: number;
      parityMismatches: number;
    };
    expect(typeof report.totalLegacyNodes).toBe('number');
    expect(typeof report.importedLegacyRecords).toBe('number');
    expect(typeof report.parityMismatches).toBe('number');
  });
});
