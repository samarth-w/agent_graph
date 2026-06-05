/**
 * buildContext tests — snippet diversity cap (20%), test-file cap (15%),
 * LRU file cache, result ranking.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { buildContext, clearFileCache } from '../src/context';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-context-test-'));
}

/** Write a small TypeScript source file and return its content */
function writeSourceFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('buildContext', () => {
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

  it('returns a ContextPayload with expected shape', () => {
    const fid = db.upsertFile('src/app.ts', 'h1', 'typescript', 10, 200).id;
    writeSourceFile(tempDir, 'src/app.ts', 'export function hello() { return 42; }\n');
    db.insertNode(fid, 'hello', 'src/app.ts::hello', 'function', 1, 1, 'export function hello()', null, true);

    const payload = buildContext(db, tempDir, 'hello');
    expect(payload).toHaveProperty('query');
    expect(payload).toHaveProperty('nodes');
    expect(payload).toHaveProperty('snippets');
    expect(payload).toHaveProperty('stats');
  });

  it('finds the queried symbol in nodes', () => {
    const fid = db.upsertFile('src/app.ts', 'h1', 'typescript', 10, 200).id;
    writeSourceFile(tempDir, 'src/app.ts', 'export function hello() { return 42; }\n');
    db.insertNode(fid, 'hello', 'src/app.ts::hello', 'function', 1, 1, 'export function hello()', null, true);

    const payload = buildContext(db, tempDir, 'hello');
    expect(payload.nodes.some(n => n.name === 'hello')).toBe(true);
  });

  it('snippet diversity cap: at most 20% of maxSnippets from any single file', () => {
    const fid = db.upsertFile('src/big.ts', 'h1', 'typescript', 100, 5000).id;
    // Write a file with 20 one-line functions
    const lines = Array.from({ length: 20 }, (_, i) => `export function fn_${i}() { return ${i}; }`);
    writeSourceFile(tempDir, 'src/big.ts', lines.join('\n') + '\n');

    for (let i = 0; i < 20; i++) {
      db.insertNode(fid, `fn_${i}`, `src/big.ts::fn_${i}`, 'function', i + 1, i + 1, `export function fn_${i}()`, null, true);
    }

    const payload = buildContext(db, tempDir, 'fn_0', { maxSnippets: 20 });
    const fromBigTs = payload.snippets.filter(s => s.file === 'src/big.ts');
    const cap = Math.max(1, Math.ceil(20 * 0.20));
    expect(fromBigTs.length).toBeLessThanOrEqual(cap);
  });

  it('test-file cap: test files do not dominate snippets', () => {
    const srcId  = db.upsertFile('src/util.ts', 'h1', 'typescript', 5, 100).id;
    const testId = db.upsertFile('__tests__/util.test.ts', 'h2', 'typescript', 5, 100).id;

    writeSourceFile(tempDir, 'src/util.ts', 'export function util() { return 1; }\n');
    writeSourceFile(tempDir, '__tests__/util.test.ts',
      Array.from({ length: 10 }, (_, i) => `it('test ${i}', () => {});`).join('\n') + '\n');

    db.insertNode(srcId,  'util',    'src/util.ts::util',                     'function', 1, 1, 'export function util()',         null, true);
    for (let i = 0; i < 10; i++) {
      db.insertNode(testId, `test_${i}`, `__tests__/util.test.ts::test_${i}`, 'function', i + 1, i + 1, `it('test ${i}', ...)`, null, false);
    }

    const payload = buildContext(db, tempDir, 'util', { maxSnippets: 10 });
    const testSnippets = payload.snippets.filter(s => s.file.includes('test'));
    const cap = Math.ceil(10 * 0.15);
    expect(testSnippets.length).toBeLessThanOrEqual(Math.max(1, cap));
  });

  it('returns empty nodes for an unmatched query', () => {
    db.upsertFile('src/empty.ts', 'h1', 'typescript', 1, 10).id;
    writeSourceFile(tempDir, 'src/empty.ts', '// empty\n');

    const payload = buildContext(db, tempDir, 'zzz_nonexistent_symbol_xyz');
    expect(payload.nodes).toHaveLength(0);
    expect(payload.snippets).toHaveLength(0);
  });

  it('LRU cache: calling buildContext twice does not throw and is consistent', () => {
    const fid = db.upsertFile('src/app.ts', 'h1', 'typescript', 5, 100).id;
    writeSourceFile(tempDir, 'src/app.ts', 'export function cached() { return true; }\n');
    db.insertNode(fid, 'cached', 'src/app.ts::cached', 'function', 1, 1, 'export function cached()', null, true);

    const first  = buildContext(db, tempDir, 'cached');
    const second = buildContext(db, tempDir, 'cached');
    expect(first.nodes.length).toBe(second.nodes.length);
    expect(first.snippets.length).toBe(second.snippets.length);
  });

  it('stats include confidence and edge_density fields', () => {
    const fid = db.upsertFile('src/app.ts', 'h1', 'typescript', 5, 100).id;
    writeSourceFile(tempDir, 'src/app.ts', 'export function main() {}\n');
    db.insertNode(fid, 'main', 'src/app.ts::main', 'function', 1, 1, 'export function main()', null, true);

    const payload = buildContext(db, tempDir, 'main');
    expect(payload.stats).toHaveProperty('confidence');
    expect(payload.stats).toHaveProperty('edge_density');
  });
});
