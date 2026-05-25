/**
 * Tests for dead code, cycle detection, stats, and query filters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findDeadCode, findCycles, getProjectStats } from '../src/graph';
import { parseQuery } from '../src/query-parser';
import { searchSymbols } from '../src/search';
import { GraphDB } from '../src/storage';
import fs from 'fs';
import path from 'path';
import os from 'os';

let db: GraphDB;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-analysis-'));
  db = await GraphDB.open(path.join(tmpDir, 'test.db'));

  // Set up a mini graph
  const f1 = db.upsertFile('src/app.ts', 'a1', 'typescript', 100, Date.now()).id;
  const f2 = db.upsertFile('src/utils.ts', 'a2', 'typescript', 200, Date.now()).id;

  // app.ts symbols
  db.insertNode(f1, 'main', 'src/app.ts::main', 'function', 1, 10, 'function main()', null, true);
  db.insertNode(f1, 'unused', 'src/app.ts::unused', 'function', 12, 20, 'function unused()', null, false);

  // utils.ts symbols
  db.insertNode(f2, 'helper', 'src/utils.ts::helper', 'function', 1, 10, 'function helper()', null, true);
  db.insertNode(f2, 'deadClass', 'src/utils.ts::deadClass', 'class', 12, 30, 'class deadClass', null, false);
  db.insertNode(f2, 'validate', 'src/utils.ts::validate', 'function', 32, 40, 'function validate()', null, true);

  // Get node IDs
  const main = db.findNodesByName('main')[0];
  const helper = db.findNodesByName('helper')[0];
  const validate = db.findNodesByName('validate')[0];

  // Edges: main -> helper -> validate -> main (cycle!)
  db.insertEdge(main.id, helper.id, 'calls');
  db.insertEdge(helper.id, validate.id, 'calls');
  db.insertEdge(validate.id, main.id, 'calls'); // creates a cycle

  // Classify roles manually
  // unused and deadClass have no edges and aren't exported → dead
  const unused = db.findNodesByName('unused')[0];
  const deadClass = db.findNodesByName('deadClass')[0];
  db.updateRole(unused.id, 'dead');
  db.updateRole(deadClass.id, 'dead');
  db.updateRole(main.id, 'entry');
  db.updateRole(helper.id, 'core');
  db.updateRole(validate.id, 'utility');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Dead code ───────────────────────────────────────────────────
describe('findDeadCode', () => {
  it('finds dead symbols', () => {
    const result = findDeadCode(db);
    expect(result.total).toBe(2);
    const names = result.dead_symbols.map(s => s.name);
    expect(names).toContain('unused');
    expect(names).toContain('deadClass');
  });

  it('filters by kind', () => {
    const result = findDeadCode(db, { kind: 'class' });
    expect(result.total).toBe(1);
    expect(result.dead_symbols[0].name).toBe('deadClass');
  });

  it('filters by file', () => {
    const result = findDeadCode(db, { file: 'app.ts' });
    expect(result.total).toBe(1);
    expect(result.dead_symbols[0].name).toBe('unused');
  });

  it('provides by_kind breakdown', () => {
    const result = findDeadCode(db);
    expect(result.by_kind.function).toBe(1);
    expect(result.by_kind.class).toBe(1);
  });
});

// ── Cycle detection ─────────────────────────────────────────────
describe('findCycles', () => {
  it('detects call cycles', () => {
    const result = findCycles(db, { edgeKinds: ['calls'] });
    expect(result.total).toBeGreaterThan(0);
    // Should find main -> helper -> validate -> main
    const cycle = result.cycles[0];
    expect(cycle.length).toBe(3);
    expect(cycle.path.length).toBe(4); // 3 nodes + back to start
  });

  it('reports files with cycles', () => {
    const result = findCycles(db);
    expect(result.files_with_cycles.length).toBeGreaterThan(0);
  });

  it('returns empty when no cycles exist (imports only, none added)', () => {
    const result = findCycles(db, { edgeKinds: ['imports'] });
    expect(result.total).toBe(0);
  });
});

// ── Project stats ───────────────────────────────────────────────
describe('getProjectStats', () => {
  it('returns correct totals', () => {
    const stats = getProjectStats(db);
    expect(stats.total_files).toBe(2);
    expect(stats.total_nodes).toBe(5);
    expect(stats.total_edges).toBe(3);
  });

  it('computes fan-in/fan-out', () => {
    const stats = getProjectStats(db);
    expect(stats.avg_fan_in).toBeGreaterThan(0);
    expect(stats.avg_fan_out).toBeGreaterThan(0);
  });

  it('identifies hotspots', () => {
    const stats = getProjectStats(db);
    expect(stats.hotspots.length).toBeGreaterThan(0);
    // The most coupled node should have coupling > 0
    expect(stats.hotspots[0].coupling).toBeGreaterThan(0);
  });

  it('has complexity distribution', () => {
    const stats = getProjectStats(db);
    expect(stats.complexity_distribution).toBeDefined();
    const total = Object.values(stats.complexity_distribution).reduce((a, b) => a + b, 0);
    expect(total).toBe(5); // all 5 nodes
  });
});

// ── Query parser: role + exported filters ───────────────────────
describe('parseQuery with role/exported', () => {
  it('parses role: filter', () => {
    const q = parseQuery('handle role:core');
    expect(q.role).toBe('core');
    expect(q.terms).toContain('handle');
  });

  it('parses exported: filter', () => {
    const q = parseQuery('main exported:true');
    expect(q.exported).toBe(true);
    expect(q.terms).toContain('main');
  });

  it('parses exported:false', () => {
    const q = parseQuery('exported:false');
    expect(q.exported).toBe(false);
  });

  it('combines role and kind', () => {
    const q = parseQuery('kind:function role:dead');
    expect(q.kind).toBe('function');
    expect(q.role).toBe('dead');
  });
});

// ── Search with role/exported filters ───────────────────────────
describe('searchSymbols with role/exported', () => {
  it('filters by role', () => {
    const results = searchSymbols(db, 'role:dead');
    const names = results.map(r => r.node.name);
    expect(names).toContain('unused');
    expect(names).toContain('deadClass');
    expect(names).not.toContain('main');
  });

  it('filters by exported:true', () => {
    const results = searchSymbols(db, 'exported:true');
    for (const r of results) {
      expect(r.node.exported).toBe(1);
    }
  });
});
