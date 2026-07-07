/**
 * explore() tests — multi-symbol deep dive that groups nodes by file,
 * clusters contiguous line ranges, and reports cross-file relationships.
 * (buildContext is covered separately in context.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { explore, clearFileCache } from '../src/context';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-explore-test-'));
}

function writeSourceFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('explore', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    clearFileCache();
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty result when no symbols match the query', () => {
    const result = explore(db, tempDir, 'zzz_totally_unknown_symbol');
    expect(result.files).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.stats.total_symbols).toBe(0);
    expect(result.stats.total_files).toBe(0);
  });

  it('groups related symbols by file and reports relationships', () => {
    const callerFileId = db.upsertFile('src/caller.ts', 'h1', 'typescript', 100, 1000).id;
    const calleeFileId = db.upsertFile('src/callee.ts', 'h2', 'typescript', 100, 1000).id;

    writeSourceFile(tempDir, 'src/caller.ts', 'export function runTask() {\n  return doWork();\n}\n');
    writeSourceFile(tempDir, 'src/callee.ts', 'export function doWork() {\n  return 42;\n}\n');

    const runTaskId = db.insertNode(callerFileId, 'runTask', 'src/caller.ts::runTask', 'function', 1, 3, 'function runTask()', null, true);
    const doWorkId = db.insertNode(calleeFileId, 'doWork', 'src/callee.ts::doWork', 'function', 1, 3, 'function doWork()', null, true);
    db.insertEdge(runTaskId, doWorkId, 'calls');

    const result = explore(db, tempDir, 'runTask');

    expect(result.stats.total_symbols).toBeGreaterThanOrEqual(2);
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    const callerGroup = result.files.find(f => f.file === 'src/caller.ts');
    expect(callerGroup).toBeDefined();
    expect(callerGroup!.symbols.some(s => s.name === 'runTask')).toBe(true);
    expect(callerGroup!.source).toContain('runTask');

    expect(result.relationships.some(r => r.source.endsWith('runTask') && r.target.endsWith('doWork'))).toBe(true);
  });

  it('clusters nearby symbols in the same file into contiguous ranges', () => {
    const fileId = db.upsertFile('src/multi.ts', 'h1', 'typescript', 200, 2000).id;
    const lines = [
      'export function first() {',
      '  return 1;',
      '}',
      'export function second() {',
      '  return 2;',
      '}',
    ];
    writeSourceFile(tempDir, 'src/multi.ts', lines.join('\n') + '\n');

    const firstId = db.insertNode(fileId, 'first', 'src/multi.ts::first', 'function', 1, 3, 'function first()', null, true);
    const secondId = db.insertNode(fileId, 'second', 'src/multi.ts::second', 'function', 4, 6, 'function second()', null, true);
    db.insertEdge(firstId, secondId, 'calls');

    const result = explore(db, tempDir, 'first');
    const group = result.files.find(f => f.file === 'src/multi.ts');
    expect(group).toBeDefined();
    expect(group!.symbols.length).toBe(2);
    expect(group!.source).toContain('first');
  });

  it('skips files whose source cannot be read on disk', () => {
    const fileId = db.upsertFile('src/ghost.ts', 'h1', 'typescript', 50, 500).id;
    db.insertNode(fileId, 'ghostFn', 'src/ghost.ts::ghostFn', 'function', 1, 2, 'function ghostFn()', null, true);
    // Note: no file written to disk for src/ghost.ts

    const result = explore(db, tempDir, 'ghostFn');
    expect(result.files.find(f => f.file === 'src/ghost.ts')).toBeUndefined();
  });

  it('respects the maxFiles option', () => {
    for (let i = 0; i < 5; i++) {
      const fid = db.upsertFile(`src/file${i}.ts`, `h${i}`, 'typescript', 50, 500).id;
      writeSourceFile(tempDir, `src/file${i}.ts`, `export function fn${i}() { return ${i}; }\n`);
      db.insertNode(fid, `fn${i}`, `src/file${i}.ts::fn${i}`, 'function', 1, 1, `function fn${i}()`, null, true);
    }

    const result = explore(db, tempDir, 'fn', { maxFiles: 2 });
    expect(result.files.length).toBeLessThanOrEqual(2);
  });
});
