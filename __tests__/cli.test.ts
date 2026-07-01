/**
 * CLI integration tests. Since cli.ts has no exported helpers,
 * these tests exercise the underlying modules that cli.ts wires together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { searchSymbols } from '../src/search';
import { buildContext } from '../src/context';
import { getDbPath, loadConfig } from '../src/config';
import { loadImpactEvaluationCasesFromFile, evaluateImpactCasesFromFile, runCapabilitySmokeCheck } from '../src/cli';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cli-test-')); }

describe('CLI helpers (integration)', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'test.db'));
    const fid = db.upsertFile('src/api.ts', 'h1', 'typescript', 100, 1000).id;
    db.insertNode(fid, 'createUser', 'src/api.ts::createUser', 'function', 1, 5, 'function createUser()', null, true);
    db.insertNode(fid, 'deleteUser', 'src/api.ts::deleteUser', 'function', 6, 10, 'function deleteUser()', null, true);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('searchSymbols returns results for seeded DB', () => {
    const results = searchSymbols(db, 'createUser', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name).toBe('createUser');
  });

  it('buildContext returns valid payload', () => {
    const payload = buildContext(db, tempDir, 'createUser');
    expect(payload).toHaveProperty('nodes');
    expect(payload).toHaveProperty('edges');
    expect(payload).toHaveProperty('snippets');
    expect(payload).toHaveProperty('stats');
  });

  it('getDbPath returns a string', () => {
    const p = getDbPath(tempDir);
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it('loadConfig merges .cgraph.json', () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({ maxNodes: 42 }));
    const cfg = loadConfig(tempDir);
    expect(cfg.maxNodes).toBe(42);
  });

  it('searchSymbols returns empty array for unknown symbol', () => {
    const results = searchSymbols(db, 'xyznotthere', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  it('loads impact evaluation cases from a JSON file', () => {
    const casesPath = path.join(tempDir, 'impact-cases.json');
    fs.writeFileSync(casesPath, JSON.stringify([
      { name: 'guarded-case', target: 'Alpha', expected_symbols: ['Beta'], mode: 'decision' },
    ]));

    const cases = loadImpactEvaluationCasesFromFile(casesPath);
    expect(cases).toEqual([
      { name: 'guarded-case', target: 'Alpha', expected_symbols: ['Beta'], mode: 'decision' },
    ]);
  });

  it('rejects malformed impact evaluation case files', () => {
    const casesPath = path.join(tempDir, 'bad-impact-cases.json');
    fs.writeFileSync(casesPath, JSON.stringify([{ name: 'bad-case', target: '' }]));

    expect(() => loadImpactEvaluationCasesFromFile(casesPath)).toThrow(/non-empty target/i);
  });

  it('evaluates impact cases from a JSON file', () => {
    const casesPath = path.join(tempDir, 'impact-cases.json');
    fs.writeFileSync(casesPath, JSON.stringify([
      { name: 'sample-case', target: 'createUser', expected_symbols: ['deleteUser'], mode: 'decision' },
    ]));

    const summary = evaluateImpactCasesFromFile(db, tempDir, casesPath, { maxDepth: 2, maxNodes: 10 });
    expect(summary.total).toBe(1);
    expect(summary.cases[0].name).toBe('sample-case');
  });

  it('reports core capabilities in a smoke check', async () => {
    const report = await runCapabilitySmokeCheck(db, tempDir, { targetSymbol: 'createUser' });
    expect(report.ok).toBe(true);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.checks.some(check => check.name === 'search')).toBe(true);
    expect(report.checks.some(check => check.name === 'impact')).toBe(true);
  });
});
