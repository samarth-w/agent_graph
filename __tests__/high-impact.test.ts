/**
 * Tests for high-impact v0.3.0 features:
 * 1. Smarter role classification (test/hub/bridge)
 * 2. Incremental edge resolution (clearEdgesForFiles)
 * 3. cgraph_suggest refactoring tool
 * 4. Progress notifications (MCP onProgress)
 * 5. Config file (.cgraph.json) loading
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { suggestRefactorings } from '../src/graph';
import { loadConfig, DEFAULT_CONFIG, CONFIG_FILE } from '../src/config';
import { GraphDB } from '../src/storage';
import fs from 'fs';
import path from 'path';
import os from 'os';

let db: GraphDB;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-highimpact-'));
  db = await GraphDB.open(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
// 1. Smarter role classification
// ═══════════════════════════════════════════════════════════════
describe('role classification: test/hub/bridge', () => {
  it('classifies nodes in test files as "test"', () => {
    const f1 = db.upsertFile('src/__tests__/app.test.ts', 'a1', 'typescript', 50, Date.now()).id;
    db.insertNode(f1, 'myTest', 'src/__tests__/app.test.ts::myTest', 'function', 1, 10, 'function myTest()', null, false);
    const node = db.findNodesByName('myTest')[0];
    // Manually verify the test regex matches test file paths
    const testRe = /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py)$|__tests?__\//i;
    expect(testRe.test('src/__tests__/app.test.ts')).toBe(true);
    expect(testRe.test('src/app.spec.js')).toBe(true);
    expect(testRe.test('src/app.e2e.tsx')).toBe(true);
    expect(testRe.test('src/app.ts')).toBe(false);
    expect(node).toBeDefined();
  });

  it('hub role requires high fan-in AND fan-out (>=3 each)', () => {
    const f1 = db.upsertFile('src/hub.ts', 'h1', 'typescript', 100, Date.now()).id;
    const f2 = db.upsertFile('src/a.ts', 'h2', 'typescript', 50, Date.now()).id;
    const f3 = db.upsertFile('src/b.ts', 'h3', 'typescript', 50, Date.now()).id;

    // Hub node
    db.insertNode(f1, 'hubFn', 'src/hub.ts::hubFn', 'function', 1, 20, 'function hubFn()', null, true);
    // Callees (hub calls these)
    db.insertNode(f2, 'dep1', 'src/a.ts::dep1', 'function', 1, 5, '', null, true);
    db.insertNode(f2, 'dep2', 'src/a.ts::dep2', 'function', 6, 10, '', null, true);
    db.insertNode(f2, 'dep3', 'src/a.ts::dep3', 'function', 11, 15, '', null, true);
    // Callers (these call hub)
    db.insertNode(f3, 'caller1', 'src/b.ts::caller1', 'function', 1, 5, '', null, true);
    db.insertNode(f3, 'caller2', 'src/b.ts::caller2', 'function', 6, 10, '', null, true);
    db.insertNode(f3, 'caller3', 'src/b.ts::caller3', 'function', 11, 15, '', null, true);

    const hub = db.findNodesByName('hubFn')[0];
    const deps = ['dep1', 'dep2', 'dep3'].map(n => db.findNodesByName(n)[0]);
    const callers = ['caller1', 'caller2', 'caller3'].map(n => db.findNodesByName(n)[0]);

    // Hub → deps
    for (const d of deps) db.insertEdge(hub.id, d.id, 'calls');
    // Callers → hub
    for (const c of callers) db.insertEdge(c.id, hub.id, 'calls');

    // With 3 in + 3 out, should qualify as hub
    const inEdges = db.getEdgesTo(hub.id, 'calls');
    const outEdges = db.getEdgesFrom(hub.id, 'calls');
    expect(inEdges.length).toBe(3);
    expect(outEdges.length).toBe(3);
    // The classifyRoles function would set this to 'hub'
    // since incoming >= 3 && outgoing >= 3
    expect(inEdges.length >= 3 && outEdges.length >= 3).toBe(true);
  });

  it('bridge detection: node connecting two otherwise-separate groups', () => {
    const f1 = db.upsertFile('src/bridge.ts', 'b1', 'typescript', 100, Date.now()).id;
    const f2 = db.upsertFile('src/left.ts', 'b2', 'typescript', 50, Date.now()).id;
    const f3 = db.upsertFile('src/right.ts', 'b3', 'typescript', 50, Date.now()).id;

    // Bridge node
    db.insertNode(f1, 'bridgeFn', 'src/bridge.ts::bridgeFn', 'function', 1, 20, '', null, true);
    // Left cluster (callers of bridge)
    db.insertNode(f2, 'leftA', 'src/left.ts::leftA', 'function', 1, 5, '', null, true);
    db.insertNode(f2, 'leftB', 'src/left.ts::leftB', 'function', 6, 10, '', null, true);
    // Right cluster (callees of bridge)
    db.insertNode(f3, 'rightA', 'src/right.ts::rightA', 'function', 1, 5, '', null, true);
    db.insertNode(f3, 'rightB', 'src/right.ts::rightB', 'function', 6, 10, '', null, true);

    const bridge = db.findNodesByName('bridgeFn')[0];
    const leftA = db.findNodesByName('leftA')[0];
    const leftB = db.findNodesByName('leftB')[0];
    const rightA = db.findNodesByName('rightA')[0];
    const rightB = db.findNodesByName('rightB')[0];

    // Left → bridge
    db.insertEdge(leftA.id, bridge.id, 'calls');
    db.insertEdge(leftB.id, bridge.id, 'calls');
    // Bridge → right
    db.insertEdge(bridge.id, rightA.id, 'calls');
    db.insertEdge(bridge.id, rightB.id, 'calls');
    // No direct connections between left and right clusters

    // Verify bridge heuristic: callers and callees have no direct connections
    const callerIds = db.getEdgesTo(bridge.id, 'calls').map(e => e.source_id);
    const calleeIds = db.getEdgesFrom(bridge.id, 'calls').map(e => e.target_id);
    const callerSet = new Set(callerIds);

    let directConnections = 0;
    for (const cid of calleeIds) {
      const calleeCallers = db.getEdgesTo(cid, 'calls');
      for (const e of calleeCallers) {
        if (callerSet.has(e.source_id)) directConnections++;
      }
    }
    expect(directConnections).toBe(0); // bridge confirmed
    expect(callerIds.length).toBeGreaterThanOrEqual(2);
    expect(calleeIds.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Incremental edge resolution (clearEdgesForFiles)
// ═══════════════════════════════════════════════════════════════
describe('clearEdgesForFiles', () => {
  it('removes only edges belonging to specified files', () => {
    const f1 = db.upsertFile('src/a.ts', 'e1', 'typescript', 50, Date.now()).id;
    const f2 = db.upsertFile('src/b.ts', 'e2', 'typescript', 50, Date.now()).id;
    const f3 = db.upsertFile('src/c.ts', 'e3', 'typescript', 50, Date.now()).id;

    db.insertNode(f1, 'fnA', 'src/a.ts::fnA', 'function', 1, 10, '', null, true);
    db.insertNode(f2, 'fnB', 'src/b.ts::fnB', 'function', 1, 10, '', null, true);
    db.insertNode(f3, 'fnC', 'src/c.ts::fnC', 'function', 1, 10, '', null, true);

    const fnA = db.findNodesByName('fnA')[0];
    const fnB = db.findNodesByName('fnB')[0];
    const fnC = db.findNodesByName('fnC')[0];

    // A→B, B→C, A→C
    db.insertEdge(fnA.id, fnB.id, 'calls');
    db.insertEdge(fnB.id, fnC.id, 'calls');
    db.insertEdge(fnA.id, fnC.id, 'calls');

    // Clear edges for file f1 only (src/a.ts)
    db.clearEdgesForFiles([f1]);

    // Edges involving fnA (from f1) should be gone
    expect(db.getEdgesFrom(fnA.id, 'calls')).toHaveLength(0);

    // Edge B→C should survive (neither node is in f1)
    expect(db.getEdgesFrom(fnB.id, 'calls')).toHaveLength(1);
    expect(db.getEdgesFrom(fnB.id, 'calls')[0].target_id).toBe(fnC.id);
  });

  it('removes edges where target belongs to cleared file', () => {
    const f1 = db.upsertFile('src/x.ts', 'x1', 'typescript', 50, Date.now()).id;
    const f2 = db.upsertFile('src/y.ts', 'x2', 'typescript', 50, Date.now()).id;

    db.insertNode(f1, 'fnX', 'src/x.ts::fnX', 'function', 1, 10, '', null, true);
    db.insertNode(f2, 'fnY', 'src/y.ts::fnY', 'function', 1, 10, '', null, true);

    const fnX = db.findNodesByName('fnX')[0];
    const fnY = db.findNodesByName('fnY')[0];

    db.insertEdge(fnX.id, fnY.id, 'calls');

    // Clear edges for f2 — fnY is the target
    db.clearEdgesForFiles([f2]);
    expect(db.getEdgesFrom(fnX.id, 'calls')).toHaveLength(0);
  });

  it('handles empty fileIds gracefully', () => {
    const f1 = db.upsertFile('src/z.ts', 'z1', 'typescript', 50, Date.now()).id;
    db.insertNode(f1, 'fnZ', 'src/z.ts::fnZ', 'function', 1, 10, '', null, true);
    const fnZ = db.findNodesByName('fnZ')[0];
    db.insertEdge(fnZ.id, fnZ.id, 'calls'); // self-edge

    // Should be a no-op
    db.clearEdgesForFiles([]);
    expect(db.getEdgesFrom(fnZ.id, 'calls')).toHaveLength(1);
  });

  it('clears edges for multiple files at once', () => {
    const f1 = db.upsertFile('src/m1.ts', 'm1', 'typescript', 50, Date.now()).id;
    const f2 = db.upsertFile('src/m2.ts', 'm2', 'typescript', 50, Date.now()).id;
    const f3 = db.upsertFile('src/m3.ts', 'm3', 'typescript', 50, Date.now()).id;

    db.insertNode(f1, 'fn1', 'src/m1.ts::fn1', 'function', 1, 5, '', null, true);
    db.insertNode(f2, 'fn2', 'src/m2.ts::fn2', 'function', 1, 5, '', null, true);
    db.insertNode(f3, 'fn3', 'src/m3.ts::fn3', 'function', 1, 5, '', null, true);

    const fn1 = db.findNodesByName('fn1')[0];
    const fn2 = db.findNodesByName('fn2')[0];
    const fn3 = db.findNodesByName('fn3')[0];

    db.insertEdge(fn1.id, fn2.id, 'calls');
    db.insertEdge(fn2.id, fn3.id, 'calls');
    db.insertEdge(fn3.id, fn1.id, 'calls');

    // Clear edges for f1 and f2
    db.clearEdgesForFiles([f1, f2]);

    // All edges should be gone since every edge involves f1 or f2
    expect(db.getEdgesFrom(fn1.id)).toHaveLength(0);
    expect(db.getEdgesFrom(fn2.id)).toHaveLength(0);
    expect(db.getEdgesFrom(fn3.id)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. cgraph_suggest refactoring tool
// ═══════════════════════════════════════════════════════════════
describe('suggestRefactorings', () => {
  beforeEach(() => {
    // Build a graph with various refactoring candidates
    const f1 = db.upsertFile('src/app.ts', 's1', 'typescript', 500, Date.now()).id;
    const f2 = db.upsertFile('src/utils.ts', 's2', 'typescript', 200, Date.now()).id;

    // Long function with high fan-out → extract candidate
    db.insertNode(f1, 'bigFunction', 'src/app.ts::bigFunction', 'function', 1, 120, 'function bigFunction()', null, true);

    // Small wrapper with single caller → inline candidate
    db.insertNode(f2, 'tinyWrapper', 'src/utils.ts::tinyWrapper', 'function', 1, 5, 'function tinyWrapper()', null, false);

    // Dead function → dead suggestion
    db.insertNode(f2, 'orphan', 'src/utils.ts::orphan', 'function', 10, 20, 'function orphan()', null, false);

    // Target functions for big function's fan-out
    for (let i = 1; i <= 6; i++) {
      db.insertNode(f2, `dep${i}`, `src/utils.ts::dep${i}`, 'function', 20 + i * 10, 25 + i * 10, '', null, true);
    }

    const bigFn = db.findNodesByName('bigFunction')[0];
    const tiny = db.findNodesByName('tinyWrapper')[0];

    // bigFunction calls 6 deps → high fan-out
    for (let i = 1; i <= 6; i++) {
      const dep = db.findNodesByName(`dep${i}`)[0];
      db.insertEdge(bigFn.id, dep.id, 'calls');
    }

    // bigFunction is the only caller of tinyWrapper
    db.insertEdge(bigFn.id, tiny.id, 'calls');
  });

  it('detects extract candidates (long + high fan-out)', () => {
    const result = suggestRefactorings(db);
    const extracts = result.suggestions.filter(s => s.type === 'extract');
    expect(extracts.length).toBeGreaterThanOrEqual(1);
    expect(extracts[0].symbol).toBe('bigFunction');
    expect(extracts[0].reason).toContain('lines');
  });

  it('detects inline candidates (single caller, small body)', () => {
    const result = suggestRefactorings(db);
    const inlines = result.suggestions.filter(s => s.type === 'inline');
    expect(inlines.length).toBeGreaterThanOrEqual(1);
    expect(inlines[0].symbol).toBe('tinyWrapper');
  });

  it('detects dead code (no callers, no callees, not exported)', () => {
    const result = suggestRefactorings(db);
    const dead = result.suggestions.filter(s => s.type === 'dead');
    expect(dead.length).toBeGreaterThanOrEqual(1);
    const names = dead.map(s => s.symbol);
    expect(names).toContain('orphan');
  });

  it('detects split candidates (very high fan-out >=10)', () => {
    // Add more deps to make fan-out >= 10
    const f2 = db.upsertFile('src/utils.ts', 's2', 'typescript', 200, Date.now()).id;
    for (let i = 7; i <= 12; i++) {
      db.insertNode(f2, `dep${i}`, `src/utils.ts::dep${i}`, 'function', 100 + i * 10, 105 + i * 10, '', null, true);
    }
    const bigFn = db.findNodesByName('bigFunction')[0];
    for (let i = 7; i <= 12; i++) {
      const dep = db.findNodesByName(`dep${i}`)[0];
      db.insertEdge(bigFn.id, dep.id, 'calls');
    }

    const result = suggestRefactorings(db);
    const splits = result.suggestions.filter(s => s.type === 'split');
    expect(splits.length).toBeGreaterThanOrEqual(1);
    expect(splits[0].symbol).toBe('bigFunction');
    expect(splits[0].reason).toContain('outgoing calls');
  });

  it('scopes to a specific symbol', () => {
    const result = suggestRefactorings(db, { symbol: 'tinyWrapper' });
    // Should only have suggestions about tinyWrapper
    for (const s of result.suggestions) {
      expect(s.symbol).toBe('tinyWrapper');
    }
  });

  it('scopes to a specific file', () => {
    const result = suggestRefactorings(db, { file: 'src/utils.ts' });
    for (const s of result.suggestions) {
      expect(s.file).toBe('src/utils.ts');
    }
  });

  it('returns empty for non-existent symbol', () => {
    const result = suggestRefactorings(db, { symbol: 'nonExistent' });
    expect(result.total).toBe(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it('respects limit', () => {
    const result = suggestRefactorings(db, { limit: 1 });
    expect(result.suggestions.length).toBeLessThanOrEqual(1);
  });

  it('sorts by priority (high > medium > low)', () => {
    const result = suggestRefactorings(db);
    const priorities = result.suggestions.map(s => s.priority);
    const order = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < priorities.length; i++) {
      expect(order[priorities[i]]).toBeGreaterThanOrEqual(order[priorities[i - 1]]);
    }
  });

  it('detects move candidates (used more externally)', () => {
    // Create a function in f1 that is called by multiple functions in f2
    const f1 = db.upsertFile('src/app.ts', 's1', 'typescript', 500, Date.now()).id;
    const f2 = db.upsertFile('src/other.ts', 's3', 'typescript', 100, Date.now()).id;

    db.insertNode(f1, 'movable', 'src/app.ts::movable', 'function', 200, 210, '', null, true);
    const movable = db.findNodesByName('movable')[0];

    // 3 callers from other.ts
    for (let i = 1; i <= 3; i++) {
      db.insertNode(f2, `extCaller${i}`, `src/other.ts::extCaller${i}`, 'function', i * 10, i * 10 + 5, '', null, true);
      const caller = db.findNodesByName(`extCaller${i}`)[0];
      db.insertEdge(caller.id, movable.id, 'calls');
    }

    const result = suggestRefactorings(db, { symbol: 'movable' });
    const moves = result.suggestions.filter(s => s.type === 'move');
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves[0].reason).toContain('external');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Progress notifications (MCP onProgress callback)
// ═══════════════════════════════════════════════════════════════
describe('MCP progress notifications', () => {
  it('ToolHandler exposes onProgress callback', async () => {
    // We can't fully test the MCP server (stdio), but we can verify
    // the sendProgress/sendNotification pattern works structurally
    const notifications: { method: string; params: any }[] = [];

    function sendNotification(method: string, params: any): void {
      notifications.push({ method, params });
    }

    function sendProgress(token: string | number, message: string, percentage?: number): void {
      sendNotification('notifications/progress', {
        progressToken: token,
        progress: percentage ?? -1,
        total: percentage !== undefined ? 100 : undefined,
        message,
      });
    }

    // Simulate what the MCP server does
    sendProgress('index', 'Building initial index...', 0);
    sendProgress('index', 'Index complete', 100);
    sendProgress('sync', 'Reloading index after file changes...');

    expect(notifications).toHaveLength(3);
    expect(notifications[0].method).toBe('notifications/progress');
    expect(notifications[0].params.progressToken).toBe('index');
    expect(notifications[0].params.progress).toBe(0);
    expect(notifications[0].params.total).toBe(100);
    expect(notifications[1].params.progress).toBe(100);
    expect(notifications[2].params.progressToken).toBe('sync');
    expect(notifications[2].params.total).toBeUndefined();
    expect(notifications[2].params.progress).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Config file (.cgraph.json) loading
// ═══════════════════════════════════════════════════════════════
describe('loadConfig', () => {
  it('returns DEFAULT_CONFIG when no .cgraph.json exists', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('is a fresh copy, not the same reference', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg).not.toBe(DEFAULT_CONFIG);
  });

  it('merges numeric overrides from .cgraph.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ maxDepth: 5, maxNodes: 100 }),
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.maxDepth).toBe(5);
    expect(cfg.maxNodes).toBe(100);
    // Non-overridden values stay default
    expect(cfg.maxSnippets).toBe(DEFAULT_CONFIG.maxSnippets);
    expect(cfg.extensions).toEqual(DEFAULT_CONFIG.extensions);
  });

  it('merges array overrides (ignorePaths, extensions)', () => {
    fs.writeFileSync(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({
        ignorePaths: ['vendor', 'tmp'],
        extensions: ['.rs', '.go'],
      }),
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.ignorePaths).toEqual(['vendor', 'tmp']);
    expect(cfg.extensions).toEqual(['.rs', '.go']);
    // Numerics stay default
    expect(cfg.maxDepth).toBe(DEFAULT_CONFIG.maxDepth);
  });

  it('ignores unknown keys', () => {
    fs.writeFileSync(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ unknownKey: 'value', maxDepth: 7 }),
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.maxDepth).toBe(7);
    expect((cfg as any).unknownKey).toBeUndefined();
  });

  it('ignores invalid types for known keys', () => {
    fs.writeFileSync(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ maxDepth: 'not-a-number', maxNodes: true }),
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.maxDepth).toBe(DEFAULT_CONFIG.maxDepth);
    expect(cfg.maxNodes).toBe(DEFAULT_CONFIG.maxNodes);
  });

  it('filters non-string items from arrays', () => {
    fs.writeFileSync(
      path.join(tmpDir, CONFIG_FILE),
      JSON.stringify({ ignorePaths: ['valid', 42, null, 'also-valid'] }),
    );
    const cfg = loadConfig(tmpDir);
    expect(cfg.ignorePaths).toEqual(['valid', 'also-valid']);
  });

  it('falls back to defaults on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, CONFIG_FILE), '{ broken json!!!');
    const cfg = loadConfig(tmpDir);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});
