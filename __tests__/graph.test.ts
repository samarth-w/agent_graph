/**
 * Graph Traversal Tests — traverse, callers, callees, impact, trace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { traverse, findCallers, findCallees, analyzeImpact, tracePath, evaluateImpactCases } from '../src/graph';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-graph-test-'));
}

describe('Graph Queries', () => {
  let tempDir: string;
  let db: GraphDB;
  let fileId: number;

  // Build a small graph: A -> B -> C, A -> D
  beforeEach(async () => {
    tempDir = createTempDir();
    const dbPath = path.join(tempDir, 'test.db');
    db = await GraphDB.open(dbPath);
    fileId = db.upsertFile('src/test.ts', 'h1', 'typescript', 100, 1000).id;

    // Create source files for code reading
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'test.ts'), 'function A() {}\nfunction B() {}\nfunction C() {}\nfunction D() {}\n');

    const idA = db.insertNode(fileId, 'A', 'src/test.ts::A', 'function', 1, 1, 'function A()', null, true);
    const idB = db.insertNode(fileId, 'B', 'src/test.ts::B', 'function', 2, 2, 'function B()', null, true);
    const idC = db.insertNode(fileId, 'C', 'src/test.ts::C', 'function', 3, 3, 'function C()', null, true);
    const idD = db.insertNode(fileId, 'D', 'src/test.ts::D', 'function', 4, 4, 'function D()', null, true);

    db.insertEdge(idA, idB, 'calls');
    db.insertEdge(idB, idC, 'calls');
    db.insertEdge(idA, idD, 'calls');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('traverse', () => {
    it('should traverse forward from A', () => {
      const nodesA = db.findNodesByName('A');
      const result = traverse(db, nodesA[0].id, { maxDepth: 3, maxNodes: 50, direction: 'forward', edgeKinds: ['calls'] });
      expect(result.nodes.length).toBeGreaterThanOrEqual(3); // A, B, D (and possibly C)
    });

    it('should traverse backward from C', () => {
      const nodesC = db.findNodesByName('C');
      const result = traverse(db, nodesC[0].id, { maxDepth: 3, maxNodes: 50, direction: 'backward', edgeKinds: ['calls'] });
      // C <- B <- A
      expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect maxDepth', () => {
      const nodesA = db.findNodesByName('A');
      const result = traverse(db, nodesA[0].id, { maxDepth: 1, maxNodes: 50, direction: 'forward', edgeKinds: ['calls'] });
      // Depth 1: A + direct neighbors (B, D)
      expect(result.nodes.length).toBeLessThanOrEqual(4);
    });

    it('should respect maxNodes', () => {
      const nodesA = db.findNodesByName('A');
      const result = traverse(db, nodesA[0].id, { maxDepth: 10, maxNodes: 2, direction: 'forward', edgeKinds: ['calls'] });
      expect(result.nodes.length).toBeLessThanOrEqual(2);
      expect(result.truncated).toBe(true);
    });
  });

  describe('findCallers', () => {
    it('should find callers of B', () => {
      const result = findCallers(db, 'B');
      const names = result.nodes.map(n => n.name);
      expect(names).toContain('A');
    });

    it('should return empty for no callers', () => {
      const result = findCallers(db, 'A');
      // A has no callers (it's the root)
      expect(result.nodes.filter(n => n.name !== 'A').length).toBe(0);
    });

    it('should return empty for nonexistent symbol', () => {
      const result = findCallers(db, 'NonExistent');
      expect(result.nodes.length).toBe(0);
    });
  });

  describe('findCallees', () => {
    it('should find callees of A', () => {
      const result = findCallees(db, 'A');
      const names = result.nodes.map(n => n.name);
      expect(names).toContain('B');
      expect(names).toContain('D');
    });

    it('should return empty callees for leaf node', () => {
      const result = findCallees(db, 'C');
      expect(result.nodes.filter(n => n.name !== 'C').length).toBe(0);
    });
  });

  describe('analyzeImpact', () => {
    it('should find impact of changing C', () => {
      const result = analyzeImpact(db, 'C');
      // Changing C impacts B (caller) and A (transitive caller)
      const names = result.impacted_nodes.map(n => n.name);
      expect(names).toContain('B');
    });

    it('should find impact of changing D', () => {
      const result = analyzeImpact(db, 'D');
      const names = result.impacted_nodes.map(n => n.name);
      expect(names).toContain('A');
    });

    it('returns evidence metadata and scope info for impacted nodes', () => {
      const result = analyzeImpact(db, 'C', { rootDir: tempDir });
      expect(result.scope).toBeDefined();
      expect(result.scope.root_dir).toBe(tempDir);
      expect(result.warnings).toEqual(expect.any(Array));
      const caller = result.impacted_nodes.find(n => n.name === 'B');
      expect(caller).toBeDefined();
      expect(caller?.relation_type).toBe('calls');
      expect(caller?.confidence).toBe('grounded');
      expect(caller?.evidence_excerpt).toContain('calls');
      expect(caller?.rationale).toContain('impact');
      expect(caller?.evidence_file).toBeDefined();
      expect(caller?.evidence_line).toBeGreaterThan(0);
    });

    it('marks guarded call sites as condition-related in decision mode', () => {
      const fid = db.upsertFile('src/guarded.ts', 'h2', 'typescript', 100, 1000).id;
      fs.writeFileSync(path.join(tempDir, 'src', 'guarded.ts'), `function A() {\n  if (flag) {\n    B();\n  }\n}\nfunction B() {}\n`);
      const idA = db.insertNode(fid, 'A', 'src/guarded.ts::A', 'function', 1, 4, 'function A()', null, true);
      const idB = db.insertNode(fid, 'B', 'src/guarded.ts::B', 'function', 5, 5, 'function B()', null, true);
      db.insertEdge(idA, idB, 'calls');

      const result = analyzeImpact(db, 'B', { rootDir: tempDir, mode: 'decision' });
      const guarded = result.impacted_nodes.find(n => n.name === 'A' && n.file_path === 'src/guarded.ts');
      expect(guarded).toBeDefined();
      expect(guarded?.relation_type).toBe('condition');
      expect(guarded?.evidence_excerpt.toLowerCase()).toContain('if');
      expect(guarded?.rationale.toLowerCase()).toContain('conditional');
      expect(result.impacted_nodes.some(n => n.confidence === 'likely')).toBe(true);
    });
  });

  describe('evaluateImpactCases', () => {
    it('summarizes benchmark results with precision and recall', () => {
      const fid = db.upsertFile('src/bench.ts', 'h3', 'typescript', 100, 1000).id;
      fs.writeFileSync(path.join(tempDir, 'src', 'bench.ts'), `function Alpha() {\n  if (enabled) {\n    Beta();\n  }\n}\nfunction Beta() {}\n`);
      const idA = db.insertNode(fid, 'Alpha', 'src/bench.ts::Alpha', 'function', 1, 4, 'function Alpha()', null, true);
      const idB = db.insertNode(fid, 'Beta', 'src/bench.ts::Beta', 'function', 5, 5, 'function Beta()', null, true);
      db.insertEdge(idA, idB, 'calls');

      const summary = evaluateImpactCases(db, tempDir, [
        { name: 'guarded-case', target: 'Beta', expected_symbols: ['Alpha'], mode: 'decision' },
      ]);

      expect(summary.total).toBe(1);
      expect(summary.passed).toBe(1);
      expect(summary.cases[0].matched).toContain('Alpha');
      expect(summary.cases[0].precision).toBeGreaterThan(0);
      expect(summary.cases[0].recall).toBe(1);
      expect(summary.precision).toBeGreaterThan(0);
      expect(summary.recall).toBe(1);
      expect(summary.cases[0].total_impacted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tracePath', () => {
    it('should find path from A to C', () => {
      const result = tracePath(db, tempDir, 'A', 'C');
      expect(result.found).toBe(true);
      expect(result.total_hops).toBe(3); // A -> B -> C
      const names = result.hops.map(h => h.name);
      expect(names).toContain('A');
      expect(names).toContain('B');
      expect(names).toContain('C');
    });

    it('should find direct path from A to B', () => {
      const result = tracePath(db, tempDir, 'A', 'B');
      expect(result.found).toBe(true);
      expect(result.total_hops).toBe(2); // A -> B
    });

    it('should not find path from C to A (wrong direction)', () => {
      const result = tracePath(db, tempDir, 'C', 'A');
      expect(result.found).toBe(false);
    });

    it('should not find path for nonexistent symbols', () => {
      const result = tracePath(db, tempDir, 'X', 'Y');
      expect(result.found).toBe(false);
    });
  });
});
