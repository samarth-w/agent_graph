import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { summarizeGraph } from '../src/graph/summary';
import { inspectDbHealth, repairDbHealth } from '../src/cli/diagnostics';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-diagnostics-test-'));
}

describe('diagnostics helpers', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'diag.db'));
    const fileId = db.upsertFile('src/demo.ts', 'h1', 'typescript', 120, 1000).id;
    const idA = db.insertNode(fileId, 'alpha', 'src/demo.ts::alpha', 'function', 1, 2, 'function alpha()', null, true);
    const idB = db.insertNode(fileId, 'beta', 'src/demo.ts::beta', 'function', 3, 4, 'function beta()', null, false);
    db.insertEdge(idA, idB, 'calls');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('summarizes graph structure for a seeded database', () => {
    const summary = summarizeGraph(db);

    expect(summary.files).toBe(1);
    expect(summary.nodes).toBe(2);
    expect(summary.edges).toBe(1);
    expect(summary.avg_out_degree).toBe(0.5);
    expect(summary.top_kinds).toEqual([
      { kind: 'function', count: 2 },
    ]);
  });

  it('inspects database health and exposes repair recommendations', () => {
    const report = inspectDbHealth(db, tempDir);

    expect(report.ok).toBe(true);
    expect(report.checks.some(check => check.name === 'schema')).toBe(true);
    expect(report.checks.some(check => check.name === 'connectivity')).toBe(true);
    expect(report.recommendations).toEqual([]);
  });

  it('repairs orphan edges and reports the repair outcome', () => {
    (db as any).db.run('PRAGMA foreign_keys = OFF');
    (db as any).db.run('INSERT INTO edges (source_id, target_id, kind) VALUES (999, 999, ?)', ['calls']);
    (db as any).db.run('PRAGMA foreign_keys = ON');

    const initial = inspectDbHealth(db, tempDir);
    expect(initial.ok).toBe(false);
    expect(initial.recommendations.some(item => item.includes('orphan'))).toBe(true);

    const repaired = repairDbHealth(db, tempDir);
    expect(repaired.ok).toBe(true);
    expect(repaired.repaired_count).toBe(1);
    expect(repaired.checks.find(check => check.name === 'connectivity')?.passed).toBe(true);
  });
});
