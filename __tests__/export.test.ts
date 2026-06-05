import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { toMermaid, toDot, toHtml } from '../src/export';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-export-test-')); }

describe('export', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
    const fid = db.upsertFile('src/a.ts', 'h1', 'typescript', 100, 1000).id;
    const idA = db.insertNode(fid, 'A', 'src/a.ts::A', 'function', 1, 2, 'function A()', null, true);
    const idB = db.insertNode(fid, 'B', 'src/a.ts::B', 'function', 3, 4, 'function B()', null, true);
    db.insertEdge(idA, idB, 'calls');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('toMermaid', () => {
    it('returns a non-empty string', () => {
      const out = toMermaid(db);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });

    it('includes mermaid graph syntax', () => {
      const out = toMermaid(db);
      expect(out).toMatch(/graph|flowchart/i);
    });
  });

  describe('toDot', () => {
    it('returns DOT language output', () => {
      const out = toDot(db);
      expect(typeof out).toBe('string');
      expect(out).toContain('digraph');
    });

    it('contains node names', () => {
      const out = toDot(db);
      expect(out).toContain('A');
    });
  });

  describe('toHtml', () => {
    it('returns HTML string', () => {
      const out = toHtml(db);
      expect(typeof out).toBe('string');
      expect(out).toMatch(/<html|<!DOCTYPE/i);
    });
  });
});
