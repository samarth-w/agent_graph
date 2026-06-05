/**
 * Edge-case tests for all graph analysis functions:
 * tracePath, getNodeDetail, findDeadCode, findCycles,
 * suggestRefactorings, validatePlan, getCodebaseDNA,
 * getProjectStats, getAutoContext, findAffected
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import {
  tracePath, getNodeDetail, findDeadCode, findCycles,
  suggestRefactorings, validatePlan, getCodebaseDNA,
  getProjectStats, getAutoContext, findAffected,
  findCallers, findCallees,
} from '../src/graph';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-gfn-test-')); }

// ─── shared setup ────────────────────────────────────────────────
let tempDir: string;
let db: GraphDB;

/** Insert a file and return its id */
function insertFile(relPath: string, lang = 'typescript'): number {
  return db.upsertFile(relPath, `h_${relPath}`, lang, 100, Date.now()).id;
}
/** Insert a node and return its numeric id */
function insertNode(fileId: number, name: string, file: string, kind = 'function', startLine = 1, endLine = 5, exported = true): number {
  return db.insertNode(fileId, name, `${file}::${name}`, kind, startLine, endLine, `function ${name}()`, null, exported);
}

beforeEach(async () => {
  tempDir = createTempDir();
  db = await GraphDB.open(path.join(tempDir, 'test.db'));
});

afterEach(() => {
  db.close();
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
//  tracePath
// ════════════════════════════════════════════════════════════════
describe('tracePath', () => {

  it('returns found:false when from symbol does not exist', () => {
    const r = tracePath(db, tempDir, 'Ghost', 'Also');
    expect(r.found).toBe(false);
    expect(r.hops).toHaveLength(0);
    expect(r.total_hops).toBe(0);
  });

  it('returns found:false when to symbol does not exist', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'A', 'src/a.ts');
    const r = tracePath(db, tempDir, 'A', 'NoSuch');
    expect(r.found).toBe(false);
  });

  it('returns found:false when no call edge connects them', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'A', 'src/a.ts');
    insertNode(fid, 'B', 'src/a.ts');
    // no edge inserted
    const r = tracePath(db, tempDir, 'A', 'B');
    expect(r.found).toBe(false);
  });

  it('finds direct 1-hop path A→B', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts');
    const idB = insertNode(fid, 'B', 'src/a.ts');
    db.insertEdge(idA, idB, 'calls');
    const r = tracePath(db, tempDir, 'A', 'B');
    expect(r.found).toBe(true);
    expect(r.total_hops).toBeGreaterThanOrEqual(1);
  });

  it('finds 2-hop path A→B→C', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 3);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 4, 6);
    const idC = insertNode(fid, 'C', 'src/a.ts', 'function', 7, 9);
    db.insertEdge(idA, idB, 'calls');
    db.insertEdge(idB, idC, 'calls');
    const r = tracePath(db, tempDir, 'A', 'C');
    expect(r.found).toBe(true);
    expect(r.hops.map(h => h.name)).toContain('A');
    expect(r.hops.map(h => h.name)).toContain('C');
  });

  it('respects maxHops=1 — does not traverse deeper', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    const idC = insertNode(fid, 'C', 'src/a.ts', 'function', 5, 6);
    db.insertEdge(idA, idB, 'calls');
    db.insertEdge(idB, idC, 'calls');
    const r = tracePath(db, tempDir, 'A', 'C', { maxHops: 1 });
    // C is 2 hops away, maxHops=1 should fail
    expect(r.found).toBe(false);
  });

  it('includes code when includeCode=true and file exists', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'function A() {}\nfunction B() {}\n');
    const fid = db.upsertFile('src/a.ts', 'h1', 'typescript', 100, Date.now()).id;
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 1);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 2, 2);
    db.insertEdge(idA, idB, 'calls');
    const r = tracePath(db, tempDir, 'A', 'B', { includeCode: true });
    expect(r.found).toBe(true);
    const hopsWithCode = r.hops.filter(h => h.code !== undefined);
    expect(hopsWithCode.length).toBeGreaterThan(0);
  });

  it('contains from and to names in result', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'Alpha', 'src/a.ts');
    const idB = insertNode(fid, 'Beta', 'src/a.ts');
    db.insertEdge(idA, idB, 'calls');
    const r = tracePath(db, tempDir, 'Alpha', 'Beta');
    expect(r.from).toBe('Alpha');
    expect(r.to).toBe('Beta');
  });
});

// ════════════════════════════════════════════════════════════════
//  getNodeDetail
// ════════════════════════════════════════════════════════════════
describe('getNodeDetail', () => {

  it('returns null for non-existent symbol', () => {
    const r = getNodeDetail(db, tempDir, 'Ghost');
    expect(r).toBeNull();
  });

  it('returns node info for existing symbol', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'myFunc', 'src/a.ts');
    const r = getNodeDetail(db, tempDir, 'myFunc');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('myFunc');
    expect(r!.kind).toBe('function');
  });

  it('populates callers and callees in trail', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'Caller', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'Target', 'src/a.ts', 'function', 3, 4);
    const idC = insertNode(fid, 'Callee', 'src/a.ts', 'function', 5, 6);
    db.insertEdge(idA, idB, 'calls'); // Caller → Target
    db.insertEdge(idB, idC, 'calls'); // Target → Callee
    const r = getNodeDetail(db, tempDir, 'Target');
    expect(r!.trail.callers.map(c => c.name)).toContain('Caller');
    expect(r!.trail.callees.map(c => c.name)).toContain('Callee');
  });

  it('returns code when includeCode=true and file exists', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'function myFunc() { return 42; }\n');
    const fid = db.upsertFile('src/a.ts', 'h1', 'typescript', 100, Date.now()).id;
    insertNode(fid, 'myFunc', 'src/a.ts', 'function', 1, 1);
    const r = getNodeDetail(db, tempDir, 'myFunc', { includeCode: true });
    expect(r!.code).toBeDefined();
    expect(r!.code).toContain('myFunc');
  });

  it('omits code when includeCode not set', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'Fn', 'src/a.ts');
    const r = getNodeDetail(db, tempDir, 'Fn');
    expect(r!.code).toBeUndefined();
  });

  it('exported flag is correct', () => {
    const fid = insertFile('src/a.ts');
    db.insertNode(fid, 'priv', 'src/a.ts::priv', 'function', 1, 2, 'function priv()', null, false);
    const r = getNodeDetail(db, tempDir, 'priv');
    expect(r!.exported).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
//  findDeadCode
// ════════════════════════════════════════════════════════════════
describe('findDeadCode', () => {

  it('returns empty result on empty DB', () => {
    const r = findDeadCode(db);
    expect(r.total).toBe(0);
    expect(r.dead_symbols).toHaveLength(0);
  });

  it('does not report live symbol as dead', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'live', 'src/a.ts');
    // Node has role='dead' only after classifyRoles; insertNode gives no role by default
    const r = findDeadCode(db);
    expect(r.dead_symbols.map(d => d.name)).not.toContain('live');
  });

  it('reports symbol with role=dead', () => {
    const fid = insertFile('src/a.ts');
    // Insert node manually with role 'dead'
    db.insertNode(fid, 'zombie', 'src/a.ts::zombie', 'function', 1, 3, 'function zombie()', null, false);
    // Manually set role to dead via raw SQL — simulate classifyRoles result
    (db as any).db.prepare("UPDATE nodes SET role = 'dead' WHERE name = 'zombie'").run();
    const r = findDeadCode(db);
    expect(r.dead_symbols.map(d => d.name)).toContain('zombie');
    expect(r.total).toBeGreaterThan(0);
  });

  it('filters by kind', () => {
    const fid = insertFile('src/a.ts');
    db.insertNode(fid, 'deadFn', 'src/a.ts::deadFn', 'function', 1, 3, '', null, false);
    db.insertNode(fid, 'deadCls', 'src/a.ts::deadCls', 'class', 4, 10, '', null, false);
    (db as any).db.prepare("UPDATE nodes SET role = 'dead'").run();

    const r = findDeadCode(db, { kind: 'function' });
    expect(r.dead_symbols.every(s => s.kind === 'function')).toBe(true);
  });

  it('filters by file', () => {
    const fid = insertFile('src/target.ts');
    const fid2 = insertFile('src/other.ts');
    db.insertNode(fid, 'inTarget', 'src/target.ts::inTarget', 'function', 1, 3, '', null, false);
    db.insertNode(fid2, 'inOther', 'src/other.ts::inOther', 'function', 1, 3, '', null, false);
    (db as any).db.prepare("UPDATE nodes SET role = 'dead'").run();

    const r = findDeadCode(db, { file: 'target' });
    expect(r.dead_symbols.map(s => s.file)).not.toContain(expect.stringContaining('other'));
  });

  it('respects limit', () => {
    const fid = insertFile('src/a.ts');
    for (let i = 0; i < 10; i++) {
      db.insertNode(fid, `dead${i}`, `src/a.ts::dead${i}`, 'function', i + 1, i + 2, '', null, false);
    }
    (db as any).db.prepare("UPDATE nodes SET role = 'dead'").run();

    const r = findDeadCode(db, { limit: 3 });
    expect(r.dead_symbols.length).toBeLessThanOrEqual(3);
    expect(r.total).toBeGreaterThan(3);
  });

  it('groups by_kind correctly', () => {
    const fid = insertFile('src/a.ts');
    db.insertNode(fid, 'fn1', 'src/a.ts::fn1', 'function', 1, 2, '', null, false);
    db.insertNode(fid, 'cls1', 'src/a.ts::cls1', 'class', 3, 10, '', null, false);
    (db as any).db.prepare("UPDATE nodes SET role = 'dead'").run();

    const r = findDeadCode(db);
    expect(typeof r.by_kind).toBe('object');
    expect(Object.keys(r.by_kind).length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  findCycles
// ════════════════════════════════════════════════════════════════
describe('findCycles', () => {

  it('returns no cycles on empty DB', () => {
    const r = findCycles(db);
    expect(r.total).toBe(0);
    expect(r.cycles).toHaveLength(0);
    expect(r.files_with_cycles).toHaveLength(0);
  });

  it('returns no cycles for linear call chain', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    const idC = insertNode(fid, 'C', 'src/a.ts', 'function', 5, 6);
    db.insertEdge(idA, idB, 'calls');
    db.insertEdge(idB, idC, 'calls');
    const r = findCycles(db);
    expect(r.total).toBe(0);
  });

  it('detects simple 2-node cycle A→B→A', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    db.insertEdge(idA, idB, 'calls');
    db.insertEdge(idB, idA, 'calls');
    const r = findCycles(db);
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.files_with_cycles).toContain('src/a.ts');
  });

  it('detects self-loop A→A', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    db.insertEdge(idA, idA, 'calls');
    const r = findCycles(db);
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it('respects maxCycles limit', () => {
    const fid = insertFile('src/a.ts');
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(insertNode(fid, `N${i}`, 'src/a.ts', 'function', i + 1, i + 2));
    // Create multiple 2-node cycles
    for (let i = 0; i < ids.length - 1; i += 2) {
      db.insertEdge(ids[i], ids[i + 1], 'calls');
      db.insertEdge(ids[i + 1], ids[i], 'calls');
    }
    const r = findCycles(db, { maxCycles: 1 });
    expect(r.cycles.length).toBeLessThanOrEqual(1);
  });

  it('edgeKinds=imports only — does not follow calls', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    db.insertEdge(idA, idB, 'calls');
    db.insertEdge(idB, idA, 'calls');
    const r = findCycles(db, { edgeKinds: ['imports'] });
    // No import edges → no cycles
    expect(r.total).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  suggestRefactorings
// ════════════════════════════════════════════════════════════════
describe('suggestRefactorings', () => {

  it('returns empty on empty DB', () => {
    const r = suggestRefactorings(db);
    expect(r.total).toBe(0);
    expect(r.suggestions).toHaveLength(0);
  });

  it('suggests split for god function (fanOut ≥ 10)', () => {
    const fid = insertFile('src/a.ts');
    const godId = insertNode(fid, 'godFn', 'src/a.ts', 'function', 1, 100);
    // Create 10 callees
    for (let i = 0; i < 10; i++) {
      const calleeId = insertNode(fid, `helper${i}`, 'src/a.ts', 'function', 101 + i * 3, 103 + i * 3);
      db.insertEdge(godId, calleeId, 'calls');
    }
    const r = suggestRefactorings(db);
    const split = r.suggestions.find(s => s.type === 'split' && s.symbol === 'godFn');
    expect(split).toBeDefined();
    expect(split!.priority).toMatch(/high|medium/);
  });

  it('suggests dead removal for orphan non-exported node', () => {
    const fid = insertFile('src/a.ts');
    db.insertNode(fid, 'orphan', 'src/a.ts::orphan', 'function', 1, 3, 'function orphan()', null, false);
    const r = suggestRefactorings(db);
    const dead = r.suggestions.find(s => s.type === 'dead' && s.symbol === 'orphan');
    expect(dead).toBeDefined();
  });

  it('suggests inline for single-caller small function', () => {
    const fid = insertFile('src/a.ts');
    const callerId = insertNode(fid, 'caller', 'src/a.ts', 'function', 1, 10);
    const tinyId   = db.insertNode(fid, 'tiny', 'src/a.ts::tiny', 'function', 11, 14, 'function tiny()', null, false);
    db.insertEdge(callerId, tinyId, 'calls');
    const r = suggestRefactorings(db);
    const inline = r.suggestions.find(s => s.type === 'inline' && s.symbol === 'tiny');
    expect(inline).toBeDefined();
    expect(inline!.priority).toBe('low');
  });

  it('scopes to a specific symbol', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'A', 'src/a.ts');
    insertNode(fid, 'B', 'src/a.ts');
    const r = suggestRefactorings(db, { symbol: 'A' });
    // Should only have suggestions about A
    const symbols = r.suggestions.map(s => s.symbol);
    expect(symbols.every(s => s === 'A')).toBe(true);
  });

  it('returns empty when scoped symbol not found', () => {
    const r = suggestRefactorings(db, { symbol: 'GhostSym' });
    expect(r.total).toBe(0);
  });

  it('respects limit', () => {
    const fid = insertFile('src/a.ts');
    for (let i = 0; i < 20; i++) {
      db.insertNode(fid, `fn${i}`, `src/a.ts::fn${i}`, 'function', i * 2 + 1, i * 2 + 2, '', null, false);
    }
    const r = suggestRefactorings(db, { limit: 5 });
    expect(r.suggestions.length).toBeLessThanOrEqual(5);
  });
});

// ════════════════════════════════════════════════════════════════
//  validatePlan
// ════════════════════════════════════════════════════════════════
describe('validatePlan', () => {

  it('returns a result shape for empty changes', () => {
    const r = validatePlan(db, {});
    expect(r).toHaveProperty('targets');
    expect(r).toHaveProperty('risk_level');
    expect(r).toHaveProperty('risk_score');
    expect(r).toHaveProperty('impacted_symbols');
    expect(r).toHaveProperty('impacted_files');
    expect(r).toHaveProperty('affected_tests');
    expect(r).toHaveProperty('warnings');
    expect(r).toHaveProperty('cycle_risks');
  });

  it('low risk for isolated symbol with no callers', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'isolated', 'src/a.ts');
    const r = validatePlan(db, { symbols: ['isolated'] });
    expect(r.risk_level).toBe('low');
    expect(r.targets).toContain('isolated');
  });

  it('warns for high-fanIn symbol (≥5 callers)', () => {
    const fid = insertFile('src/a.ts');
    const targetId = insertNode(fid, 'hotFn', 'src/a.ts', 'function', 1, 5);
    for (let i = 0; i < 6; i++) {
      const callerId = insertNode(fid, `caller${i}`, 'src/a.ts', 'function', 10 + i * 2, 11 + i * 2);
      db.insertEdge(callerId, targetId, 'calls');
    }
    const r = validatePlan(db, { symbols: ['hotFn'] });
    expect(r.warnings.some(w => w.includes('hotFn'))).toBe(true);
  });

  it('identifies affected test files', () => {
    const fid = insertFile('src/a.ts');
    const tfid = insertFile('__tests__/a.test.ts');
    const targetId = insertNode(fid, 'myFn', 'src/a.ts', 'function', 1, 5);
    const testId   = insertNode(tfid, 'testMyFn', '__tests__/a.test.ts', 'function', 1, 5);
    db.insertEdge(testId, targetId, 'calls'); // test calls myFn
    const r = validatePlan(db, { symbols: ['myFn'] });
    expect(r.affected_tests.some(t => t.includes('.test.'))).toBe(true);
  });

  it('handles file-based changes', () => {
    const fid = insertFile('src/module.ts');
    insertNode(fid, 'fn', 'src/module.ts');
    const r = validatePlan(db, { files: ['src/module.ts'] });
    expect(r.targets).toContain('src/module.ts');
  });

  it('medium risk for moderate blast radius', () => {
    const fid = insertFile('src/a.ts');
    const coreId = insertNode(fid, 'core', 'src/a.ts', 'function', 1, 3);
    // 10 callers → risk_score ≥ 10
    for (let i = 0; i < 10; i++) {
      const c = insertNode(fid, `c${i}`, 'src/a.ts', 'function', 10 + i * 3, 12 + i * 3);
      db.insertEdge(c, coreId, 'calls');
    }
    const r = validatePlan(db, { symbols: ['core'] });
    expect(['medium', 'high']).toContain(r.risk_level);
  });
});

// ════════════════════════════════════════════════════════════════
//  getCodebaseDNA
// ════════════════════════════════════════════════════════════════
describe('getCodebaseDNA', () => {

  it('returns full DNA shape on empty DB', () => {
    const r = getCodebaseDNA(db);
    expect(r).toHaveProperty('languages');
    expect(r).toHaveProperty('health');
    expect(r).toHaveProperty('size');
    expect(r).toHaveProperty('summary');
    expect(r.health).toHaveProperty('modularity');
    expect(r.health).toHaveProperty('dead_code');
    expect(r.health).toHaveProperty('test_coverage');
    expect(r.health).toHaveProperty('complexity');
    expect(r.health).toHaveProperty('overall');
  });

  it('all health scores are 0-100', () => {
    const r = getCodebaseDNA(db);
    for (const v of Object.values(r.health)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('reflects added files in size', () => {
    insertFile('src/a.ts');
    insertFile('src/b.ts');
    const r = getCodebaseDNA(db);
    expect(r.size.files).toBeGreaterThanOrEqual(2);
  });

  it('test_coverage increases when test files added', () => {
    insertFile('src/a.ts', 'typescript');
    const r1 = getCodebaseDNA(db);
    insertFile('__tests__/a.test.ts', 'typescript');
    const r2 = getCodebaseDNA(db);
    expect(r2.health.test_coverage).toBeGreaterThanOrEqual(r1.health.test_coverage);
  });

  it('complexity drops when god function added', () => {
    const fid = insertFile('src/a.ts');
    const godId = insertNode(fid, 'god', 'src/a.ts', 'function', 1, 100);
    for (let i = 0; i < 10; i++) {
      const h = insertNode(fid, `h${i}`, 'src/a.ts', 'function', 200 + i, 201 + i);
      db.insertEdge(godId, h, 'calls');
    }
    const r = getCodebaseDNA(db);
    expect(r.health.complexity).toBeLessThan(100);
  });

  it('modularity is 100 with no cycles', () => {
    const fid = insertFile('src/a.ts');
    const a = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const b = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    db.insertEdge(a, b, 'calls'); // no cycle
    const r = getCodebaseDNA(db);
    expect(r.health.modularity).toBe(100);
  });

  it('summary is a non-empty string', () => {
    const r = getCodebaseDNA(db);
    expect(typeof r.summary).toBe('string');
    expect(r.summary.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  getProjectStats
// ════════════════════════════════════════════════════════════════
describe('getProjectStats', () => {

  it('returns correct shape on empty DB', () => {
    const r = getProjectStats(db);
    expect(r).toHaveProperty('total_files');
    expect(r).toHaveProperty('total_nodes');
    expect(r).toHaveProperty('total_edges');
    expect(r).toHaveProperty('hotspots');
    expect(r).toHaveProperty('file_coupling');
    expect(r).toHaveProperty('complexity_distribution');
    expect(r.hotspots).toHaveLength(0);
  });

  it('counts files and nodes correctly', () => {
    insertFile('src/a.ts');
    insertFile('src/b.ts');
    const fid = insertFile('src/c.ts');
    insertNode(fid, 'fn', 'src/c.ts');
    const r = getProjectStats(db);
    expect(r.total_files).toBeGreaterThanOrEqual(3);
    expect(r.total_nodes).toBeGreaterThanOrEqual(1);
  });

  it('hotspots are sorted by coupling descending', () => {
    const fid = insertFile('src/a.ts');
    const hub = insertNode(fid, 'hub', 'src/a.ts', 'function', 1, 5);
    for (let i = 0; i < 5; i++) {
      const c = insertNode(fid, `c${i}`, 'src/a.ts', 'function', 10 + i * 3, 12 + i * 3);
      db.insertEdge(c, hub, 'calls');
    }
    const r = getProjectStats(db);
    const couplings = r.hotspots.map(h => h.coupling);
    for (let i = 1; i < couplings.length; i++) {
      expect(couplings[i - 1]).toBeGreaterThanOrEqual(couplings[i]);
    }
  });

  it('complexity_distribution buckets cover all nodes', () => {
    const fid = insertFile('src/a.ts');
    insertNode(fid, 'a', 'src/a.ts', 'function', 1, 2);
    insertNode(fid, 'b', 'src/a.ts', 'function', 3, 4);
    const r = getProjectStats(db);
    const totalInBuckets = Object.values(r.complexity_distribution).reduce((sum, n) => sum + n, 0);
    expect(totalInBuckets).toBe(r.total_nodes);
  });

  it('avg_fan_in and avg_fan_out are numbers ≥ 0', () => {
    const r = getProjectStats(db);
    expect(r.avg_fan_in).toBeGreaterThanOrEqual(0);
    expect(r.avg_fan_out).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  getAutoContext
// ════════════════════════════════════════════════════════════════
describe('getAutoContext', () => {

  it('returns empty result for non-existent file', () => {
    const r = getAutoContext(db, 'src/ghost.ts');
    expect(r.file).toBe('src/ghost.ts');
    expect(r.symbols).toHaveLength(0);
    expect(r.related_tests).toHaveLength(0);
  });

  it('returns symbols for an indexed file', () => {
    const fid = insertFile('src/api.ts');
    insertNode(fid, 'createUser', 'src/api.ts');
    insertNode(fid, 'deleteUser', 'src/api.ts', 'function', 6, 10);
    const r = getAutoContext(db, 'src/api.ts');
    expect(r.symbols.map(s => s.name)).toContain('createUser');
    expect(r.symbols.map(s => s.name)).toContain('deleteUser');
  });

  it('detects related test files by base name', () => {
    insertFile('src/api.ts');
    insertFile('__tests__/api.test.ts');
    const r = getAutoContext(db, 'src/api.ts');
    expect(r.related_tests.some(t => t.includes('api.test'))).toBe(true);
  });

  it('populates imports_from when import edges exist', () => {
    const fid1 = insertFile('src/a.ts');
    const fid2 = insertFile('src/b.ts');
    const idA = insertNode(fid1, 'A', 'src/a.ts');
    const idB = insertNode(fid2, 'B', 'src/b.ts');
    db.insertEdge(idA, idB, 'imports'); // a imports from b
    const r = getAutoContext(db, 'src/a.ts');
    expect(r.imports_from).toContain('src/b.ts');
  });

  it('populates imported_by when import edges exist', () => {
    const fid1 = insertFile('src/a.ts');
    const fid2 = insertFile('src/b.ts');
    const idA = insertNode(fid1, 'A', 'src/a.ts');
    const idB = insertNode(fid2, 'B', 'src/b.ts');
    db.insertEdge(idB, idA, 'imports'); // b imports from a
    const r = getAutoContext(db, 'src/a.ts');
    expect(r.imported_by).toContain('src/b.ts');
  });

  it('stats.total equals number of symbols in file', () => {
    const fid = insertFile('src/stats.ts');
    insertNode(fid, 'x', 'src/stats.ts', 'function', 1, 2);
    insertNode(fid, 'y', 'src/stats.ts', 'function', 3, 4);
    const r = getAutoContext(db, 'src/stats.ts');
    expect(r.stats.total).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════
//  findAffected
// ════════════════════════════════════════════════════════════════
describe('findAffected', () => {

  it('returns empty for empty changed files list', () => {
    const r = findAffected(db, []);
    expect(r.affected_tests).toHaveLength(0);
    expect(r.total_affected).toBe(0);
    expect(r.changed_files).toHaveLength(0);
  });

  it('returns empty when changed file is not indexed', () => {
    const r = findAffected(db, ['src/unknown.ts']);
    expect(r.affected_tests).toHaveLength(0);
  });

  it('finds test files that call changed symbol', () => {
    const fid  = insertFile('src/utils.ts');
    const tfid = insertFile('__tests__/utils.test.ts');
    const utilId = insertNode(fid, 'formatDate', 'src/utils.ts');
    const testId = insertNode(tfid, 'testFormatDate', '__tests__/utils.test.ts', 'function', 1, 5);
    db.insertEdge(testId, utilId, 'calls');
    const r = findAffected(db, ['src/utils.ts']);
    expect(r.affected_tests).toContain('__tests__/utils.test.ts');
    expect(r.total_affected).toBeGreaterThan(0);
  });

  it('does not include non-test files in affected_tests', () => {
    const fid  = insertFile('src/a.ts');
    const fid2 = insertFile('src/b.ts');
    const idA  = insertNode(fid, 'A', 'src/a.ts');
    const idB  = insertNode(fid2, 'B', 'src/b.ts');
    db.insertEdge(idB, idA, 'calls'); // b calls a
    const r = findAffected(db, ['src/a.ts']);
    // src/b.ts is not a test file
    expect(r.affected_tests).not.toContain('src/b.ts');
  });

  it('uses custom testPattern', () => {
    const fid  = insertFile('src/a.ts');
    const tfid = insertFile('specs/a.spec.ts');
    const idA  = insertNode(fid, 'A', 'src/a.ts');
    const idT  = insertNode(tfid, 'specA', 'specs/a.spec.ts', 'function', 1, 3);
    db.insertEdge(idT, idA, 'calls');
    const r = findAffected(db, ['src/a.ts'], { testPattern: '**/*.spec.ts' });
    expect(r.affected_tests).toContain('specs/a.spec.ts');
  });

  it('depth is included in result', () => {
    const r = findAffected(db, [], { depth: 3 });
    expect(r.depth).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════
//  findCallers / findCallees — edge cases
// ════════════════════════════════════════════════════════════════
describe('findCallers / findCallees edge cases', () => {

  it('findCallers returns empty for unknown symbol', () => {
    const r = findCallers(db, 'Ghost');
    expect(r.nodes).toHaveLength(0);
  });

  it('findCallees returns empty for unknown symbol', () => {
    const r = findCallees(db, 'Ghost');
    expect(r.nodes).toHaveLength(0);
  });

  it('findCallers returns direct callers', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    db.insertEdge(idA, idB, 'calls'); // A calls B
    const r = findCallers(db, 'B');
    expect(r.nodes.map(n => n.name)).toContain('A');
  });

  it('findCallees returns direct callees', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    db.insertEdge(idA, idB, 'calls'); // A calls B
    const r = findCallees(db, 'A');
    expect(r.nodes.map(n => n.name)).toContain('B');
  });

  it('maxNodes=0 returns truncated result', () => {
    const fid = insertFile('src/a.ts');
    const idA = insertNode(fid, 'A', 'src/a.ts', 'function', 1, 2);
    const idB = insertNode(fid, 'B', 'src/a.ts', 'function', 3, 4);
    db.insertEdge(idA, idB, 'calls');
    const r = findCallers(db, 'B', { maxNodes: 0 });
    // With maxNodes=0, should return the seed node only (or truncated)
    expect(r.truncated).toBe(true);
  });
});
