/**
 * Storage Tests — GraphDB operations (sql.js backed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-storage-test-'));
}

describe('GraphDB', () => {
  let tempDir: string;
  let dbPath: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    dbPath = path.join(tempDir, 'test.db');
    db = await GraphDB.open(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('File operations', () => {
    it('should upsert a file and return its id', () => {
      const { id, changed } = db.upsertFile('src/index.ts', 'abc123', 'typescript', 100, Date.now());
      expect(id).toBeGreaterThan(0);
      expect(changed).toBe(true);
    });

    it('should detect unchanged files', () => {
      db.upsertFile('src/index.ts', 'abc123', 'typescript', 100, 1000);
      const { changed } = db.upsertFile('src/index.ts', 'abc123', 'typescript', 100, 1000);
      expect(changed).toBe(false);
    });

    it('should detect changed files', () => {
      db.upsertFile('src/index.ts', 'abc123', 'typescript', 100, 1000);
      const { changed } = db.upsertFile('src/index.ts', 'def456', 'typescript', 150, 2000);
      expect(changed).toBe(true);
    });
  });

  describe('Node operations', () => {
    it('should insert and retrieve nodes by name', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      db.insertNode(fileId, 'myFunction', 'src/app.ts::myFunction', 'function', 1, 10, 'function myFunction()', null, true);

      const nodes = db.findNodesByName('myFunction');
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('myFunction');
      expect(nodes[0].kind).toBe('function');
      expect(nodes[0].exported).toBe(1);
    });

    it('should find multiple nodes with same name', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      const fileId2 = db.upsertFile('src/lib.ts', 'hash2', 'typescript', 50, 1000).id;
      db.insertNode(fileId, 'parse', 'src/app.ts::parse', 'function', 1, 5, null, null, true);
      db.insertNode(fileId2, 'parse', 'src/lib.ts::parse', 'function', 1, 5, null, null, false);

      const nodes = db.findNodesByName('parse');
      expect(nodes.length).toBe(2);
    });
  });

  describe('Edge operations', () => {
    it('should insert edges and query by source', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      const id1 = db.insertNode(fileId, 'caller', 'src/app.ts::caller', 'function', 1, 5, null, null, true);
      const id2 = db.insertNode(fileId, 'callee', 'src/app.ts::callee', 'function', 6, 10, null, null, true);
      db.insertEdge(id1, id2, 'calls');

      const edges = db.getEdgesFrom(id1, 'calls');
      expect(edges.length).toBe(1);
      expect(edges[0].target_id).toBe(id2);
    });

    it('should query edges by target', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      const id1 = db.insertNode(fileId, 'caller', 'src/app.ts::caller', 'function', 1, 5, null, null, true);
      const id2 = db.insertNode(fileId, 'callee', 'src/app.ts::callee', 'function', 6, 10, null, null, true);
      db.insertEdge(id1, id2, 'calls');

      const edges = db.getEdgesTo(id2, 'calls');
      expect(edges.length).toBe(1);
      expect(edges[0].source_id).toBe(id1);
    });

    it('should default edge cost fields when not provided', () => {
      const fileId = db.upsertFile('src/cost.ts', 'hash-c1', 'typescript', 50, 1000).id;
      const id1 = db.insertNode(fileId, 'producer', 'src/cost.ts::producer', 'function', 1, 2, null, null, true);
      const id2 = db.insertNode(fileId, 'consumer', 'src/cost.ts::consumer', 'function', 3, 4, null, null, true);
      db.insertEdge(id1, id2, 'calls');

      const edge = db.getEdgesFrom(id1, 'calls')[0] as any;
      expect(edge.tokens_in).toBe(0);
      expect(edge.tokens_out).toBe(0);
      expect(edge.latency_ms).toBe(0);
      expect(edge.est_cost_usd).toBe(0);
    });

    it('should persist provided edge cost fields', () => {
      const fileId = db.upsertFile('src/cost.ts', 'hash-c2', 'typescript', 50, 1000).id;
      const id1 = db.insertNode(fileId, 'producer', 'src/cost.ts::producer', 'function', 1, 2, null, null, true);
      const id2 = db.insertNode(fileId, 'consumer', 'src/cost.ts::consumer', 'function', 3, 4, null, null, true);
      db.insertEdge(id1, id2, 'calls', {
        tokens_in: 120,
        tokens_out: 44,
        latency_ms: 980,
        est_cost_usd: 0.0042,
      });

      const edge = db.getEdgesFrom(id1, 'calls')[0] as any;
      expect(edge.tokens_in).toBe(120);
      expect(edge.tokens_out).toBe(44);
      expect(edge.latency_ms).toBe(980);
      expect(edge.est_cost_usd).toBe(0.0042);
    });
  });

  describe('FTS Search', () => {
    it('should find nodes by name search', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      db.insertNode(fileId, 'buildContext', 'src/app.ts::buildContext', 'function', 1, 10, null, null, true);

      const results = db.ftsSearch('buildContext', 10);
      expect(results.length).toBe(1);
      expect(results[0].node.name).toBe('buildContext');
    });

    it('should rank exact matches higher', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      db.insertNode(fileId, 'build', 'src/app.ts::build', 'function', 1, 5, null, null, true);
      db.insertNode(fileId, 'buildContext', 'src/app.ts::buildContext', 'function', 6, 10, null, null, true);

      const results = db.ftsSearch('build', 10);
      expect(results.length).toBe(2);
      // Exact match should come first (lower rank = better)
      expect(results[0].node.name).toBe('build');
    });

    it('should boost exported symbols', () => {
      const fileId = db.upsertFile('src/app.ts', 'hash1', 'typescript', 50, 1000).id;
      db.insertNode(fileId, 'helper', 'src/app.ts::helper', 'function', 1, 5, null, null, false);
      db.insertNode(fileId, 'helper', 'src/lib.ts::helper', 'function', 1, 5, null, null, true);

      const results = db.ftsSearch('helper', 10);
      expect(results.length).toBe(2);
      // Exported one should rank higher
      expect(results[0].node.exported).toBe(1);
    });

    it('should return empty for no matches', () => {
      const results = db.ftsSearch('nonexistent', 10);
      expect(results).toEqual([]);
    });
  });

  describe('Persistence', () => {
    it('should save and reload', async () => {
      const persistDir = createTempDir();
      const persistPath = path.join(persistDir, 'persist.db');
      try {
        const db1 = await GraphDB.open(persistPath);
        const fileId = db1.upsertFile('src/x.ts', 'h1', 'typescript', 10, 1000).id;
        db1.insertNode(fileId, 'myFn', 'src/x.ts::myFn', 'function', 1, 5, null, null, true);
        db1.save();
        db1.close();

        const db2 = await GraphDB.open(persistPath);
        const nodes = db2.findNodesByName('myFn');
        expect(nodes.length).toBe(1);
        db2.close();
      } finally {
        if (fs.existsSync(persistDir)) fs.rmSync(persistDir, { recursive: true, force: true });
      }
    });

    it('should share a single in-memory connection for the same database path', async () => {
      const persistDir = createTempDir();
      const persistPath = path.join(persistDir, 'shared.db');
      try {
        const db1 = await GraphDB.open(persistPath);
        const db2 = await GraphDB.open(persistPath);

        const fileId = db1.upsertFile('src/shared.ts', 'h2', 'typescript', 9, 1000).id;
        db1.insertNode(fileId, 'sharedFn', 'src/shared.ts::sharedFn', 'function', 1, 3, null, null, true);

        const nodes = db2.findNodesByName('sharedFn');
        expect(nodes.length).toBe(1);

        db1.close();
        db2.close();
      } finally {
        if (fs.existsSync(persistDir)) fs.rmSync(persistDir, { recursive: true, force: true });
      }
    });
  });

  describe('Transactions', () => {
    it('should commit on success', () => {
      db.transaction(() => {
        const fileId = db.upsertFile('a.ts', 'h', 'typescript', 1, 1).id;
        db.insertNode(fileId, 'txnFn', 'a.ts::txnFn', 'function', 1, 1, null, null, false);
      });
      const nodes = db.findNodesByName('txnFn');
      expect(nodes.length).toBe(1);
    });

    it('should rollback on error', () => {
      try {
        db.transaction(() => {
          const fileId = db.upsertFile('b.ts', 'h', 'typescript', 1, 1).id;
          db.insertNode(fileId, 'rollbackFn', 'b.ts::rollbackFn', 'function', 1, 1, null, null, false);
          throw new Error('intentional');
        });
      } catch {}
      const nodes = db.findNodesByName('rollbackFn');
      expect(nodes.length).toBe(0);
    });
  });
});
