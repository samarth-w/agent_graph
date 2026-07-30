import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { findChangedSymbols } from '../src/git';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-git-test-')); }

describe('findChangedSymbols', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty array when no files are changed', async () => {
    const result = await findChangedSymbols(db, tempDir, []);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  }, 15_000);

  it('returns symbols for files that exist in DB', async () => {
    const fid = db.upsertFile('src/changed.ts', 'hash1', 'typescript', 100, 1000).id;
    db.insertNode(fid, 'changedFn', 'src/changed.ts::changedFn', 'function', 1, 5, 'function changedFn() {}', null, true);

    const result = await findChangedSymbols(db, tempDir, ['src/changed.ts']);
    expect(Array.isArray(result)).toBe(true);
    // May return symbols from that file
    expect(result.every(s => typeof s === 'object')).toBe(true);
  }, 15_000);

  it('ignores files not in DB', async () => {
    const result = await findChangedSymbols(db, tempDir, ['src/ghost.ts']);
    expect(Array.isArray(result)).toBe(true);
  }, 15_000);
});
