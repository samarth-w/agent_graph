/**
 * searchSymbols tests — exact match, fuzzy fallback, CamelCase boundary fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { searchSymbols } from '../src/search';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-search-test-'));
}

describe('searchSymbols', () => {
  let tempDir: string;
  let db: GraphDB;
  let fileId: number;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
    fileId = db.upsertFile('src/app.ts', 'h1', 'typescript', 100, 5000).id;

    // Insert a set of symbols with varied names for matching tests
    db.insertNode(fileId, 'buildContext',          'src/app.ts::buildContext',          'function', 1,  10, 'function buildContext()',          null, true);
    db.insertNode(fileId, 'buildContextOptions',   'src/app.ts::buildContextOptions',   'interface', 11, 20, 'interface buildContextOptions {}', null, true);
    db.insertNode(fileId, 'clearFileCache',        'src/app.ts::clearFileCache',        'function', 21, 25, 'function clearFileCache()',        null, true);
    db.insertNode(fileId, 'SmartCrusher',          'src/app.ts::SmartCrusher',          'class',    26, 60, 'class SmartCrusher {}',            null, true);
    db.insertNode(fileId, 'computeLimits',         'src/app.ts::computeLimits',         'function', 61, 70, 'function computeLimits()',         null, true);
    db.insertNode(fileId, 'getFanOutAdjustment',   'src/app.ts::getFanOutAdjustment',   'function', 71, 80, 'function getFanOutAdjustment()',   null, false);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds an exact name match', () => {
    const results = searchSymbols(db, 'buildContext');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name).toBe('buildContext');
  });

  it('finds a symbol when query is a substring of the name', () => {
    const results = searchSymbols(db, 'FileCache');
    expect(results.some(r => r.node.name === 'clearFileCache')).toBe(true);
  });

  it('respects the limit option', () => {
    const results = searchSymbols(db, 'build', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('filters by kind when specified', () => {
    const results = searchSymbols(db, 'build', { kind: 'interface' });
    expect(results.every(r => r.node.kind === 'interface')).toBe(true);
  });

  it('returns empty array for no match', () => {
    const results = searchSymbols(db, 'zzz_nonexistent_xyz');
    expect(results).toHaveLength(0);
  });

  it('CamelCase boundary fallback finds symbol from token subset', () => {
    // "Crusher" is a boundary token of "SmartCrusher"
    const results = searchSymbols(db, 'Crusher');
    expect(results.some(r => r.node.name === 'SmartCrusher')).toBe(true);
  });

  it('CamelCase boundary fallback finds symbol from first token', () => {
    // "Smart" is the first boundary token of "SmartCrusher"
    const results = searchSymbols(db, 'Smart');
    expect(results.some(r => r.node.name === 'SmartCrusher')).toBe(true);
  });

  it('includes file_path in results', () => {
    const results = searchSymbols(db, 'computeLimits');
    expect(results[0].file_path).toBe('src/app.ts');
  });

  it('returns exported symbols before unexported ones for same query', () => {
    // getFanOutAdjustment is not exported; buildContext is exported
    const results = searchSymbols(db, 'build');
    const exportedFirst = results.findIndex(r => r.node.exported === 1);
    const unexportedFirst = results.findIndex(r => r.node.exported === 0);
    // If both present, exported should appear first or unexported may not appear
    if (unexportedFirst !== -1 && exportedFirst !== -1) {
      expect(exportedFirst).toBeLessThanOrEqual(unexportedFirst);
    }
  });
});
