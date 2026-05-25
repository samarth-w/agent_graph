/**
 * Graph Traversal Tests — traverse, callers, callees, impact, trace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { traverse, findCallers, findCallees, analyzeImpact, tracePath } from '../src/graph';

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
