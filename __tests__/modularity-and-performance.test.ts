import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { loadImpactEvaluationCasesFromFile } from '../src/cli/impact';
import { traverse, findCallees, findCallers } from '../src/graph/traversal';
import { checkPerformanceBudget, loadPerformanceBudget } from '../src/performance';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-modularity-test-'));
}

describe('modular helpers and performance budget', () => {
  let tempDir: string;
  let db: GraphDB;

  beforeEach(async () => {
    tempDir = createTempDir();
    db = await GraphDB.open(path.join(tempDir, 'mod.db'));
    const fileId = db.upsertFile('src/demo.ts', 'h1', 'typescript', 100, 1000).id;
    const idA = db.insertNode(fileId, 'alpha', 'src/demo.ts::alpha', 'function', 1, 2, 'function alpha()', null, true);
    const idB = db.insertNode(fileId, 'beta', 'src/demo.ts::beta', 'function', 3, 4, 'function beta()', null, false);
    db.insertEdge(idA, idB, 'calls');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads impact case definitions from the CLI impact submodule', () => {
    const casesPath = path.join(tempDir, 'impact.json');
    fs.writeFileSync(casesPath, JSON.stringify([{ name: 'demo', target: 'alpha', expected_symbols: ['beta'], mode: 'decision' }]));

    const cases = loadImpactEvaluationCasesFromFile(casesPath);
    expect(cases[0].target).toBe('alpha');
    expect(cases[0].expected_symbols).toEqual(['beta']);
  });

  it('uses traversal helpers from the graph submodule', () => {
    const nodes = db.findNodesByName('alpha');
    const result = traverse(db, nodes[0].id, { maxDepth: 2, maxNodes: 10, direction: 'forward', edgeKinds: ['calls'] });

    expect(result.nodes.some(node => node.name === 'alpha')).toBe(true);
    expect(result.nodes.some(node => node.name === 'beta')).toBe(true);
    expect(findCallees(db, 'alpha').nodes.some(node => node.name === 'beta')).toBe(true);
    expect(findCallers(db, 'beta').nodes.some(node => node.name === 'alpha')).toBe(true);
  });

  it('evaluates a performance budget against a fresh snapshot', () => {
    const budget = loadPerformanceBudget(path.join(tempDir, 'budget.json'));
    const result = checkPerformanceBudget({ nodes: 80, maxDepth: 4, durationMs: 1800, passRate: 0.92 }, budget);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('falls back to defaults when the budget file is missing', () => {
    const budget = loadPerformanceBudget(path.join(tempDir, 'does-not-exist.json'));
    expect(budget).toEqual({ maxNodes: 100, maxDepth: 5, durationMs: 5000, passRate: 0.8 });
  });

  it('loads a partial budget file and fills in missing fields with defaults', () => {
    const budgetPath = path.join(tempDir, 'partial-budget.json');
    fs.writeFileSync(budgetPath, JSON.stringify({ maxNodes: 250, passRate: 'not-a-number' }));

    const budget = loadPerformanceBudget(budgetPath);
    expect(budget).toEqual({ maxNodes: 250, maxDepth: 5, durationMs: 5000, passRate: 0.8 });
  });

  it('loads a fully specified budget file', () => {
    const budgetPath = path.join(tempDir, 'full-budget.json');
    fs.writeFileSync(budgetPath, JSON.stringify({ maxNodes: 10, maxDepth: 2, durationMs: 500, passRate: 0.5 }));

    const budget = loadPerformanceBudget(budgetPath);
    expect(budget).toEqual({ maxNodes: 10, maxDepth: 2, durationMs: 500, passRate: 0.5 });
  });

  it('reports every violation when a snapshot breaches all budget dimensions', () => {
    const budget = { maxNodes: 10, maxDepth: 2, durationMs: 100, passRate: 0.9 };
    const result = checkPerformanceBudget({ nodes: 20, maxDepth: 5, durationMs: 500, passRate: 0.1 }, budget);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(4);
    expect(result.violations[0]).toContain('node count 20 exceeds budget 10');
    expect(result.violations[1]).toContain('max depth 5 exceeds budget 2');
    expect(result.violations[2]).toContain('duration 500ms exceeds budget 100ms');
    expect(result.violations[3]).toContain('pass rate 0.1 is below budget 0.9');
  });

  it('ignores fields that are absent from the snapshot', () => {
    const budget = { maxNodes: 10, maxDepth: 2, durationMs: 100, passRate: 0.9 };
    const result = checkPerformanceBudget({}, budget);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('uses the default budget when none is provided', () => {
    const result = checkPerformanceBudget({ nodes: 50 });
    expect(result.budget).toEqual({ maxNodes: 100, maxDepth: 5, durationMs: 5000, passRate: 0.8 });
    expect(result.ok).toBe(true);
  });
});
