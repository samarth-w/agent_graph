/**
 * Adaptive limits tests — computeLimits size tiers, fan-out adjustment, explicit overrides.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphDB } from '../src/storage';
import { computeLimits } from '../src/adaptive';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-adaptive-test-'));
}

describe('computeLimits', () => {
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

  it('returns explicit overrides immediately when both provided', () => {
    const result = computeLimits(db, 'callers', { explicitDepth: 7, explicitMaxNodes: 99 });
    expect(result).toEqual({ maxDepth: 7, maxNodes: 99 });
  });

  it('respects partial explicit override for depth only', () => {
    const result = computeLimits(db, 'callers', { explicitDepth: 5 });
    expect(result.maxDepth).toBe(5);
    // maxNodes still adaptive (not overridden)
    expect(result.maxNodes).toBeGreaterThan(0);
  });

  it('applies small-repo depth bonus for empty DB (0 nodes < 200 threshold)', () => {
    // BASE callers: { maxDepth: 3, maxNodes: 40 }, small tier: depthBonus +1, nodesBonus +20
    const result = computeLimits(db, 'callers');
    expect(result.maxDepth).toBe(4);
    expect(result.maxNodes).toBe(60);
  });

  it('applies no tier adjustment for medium repo (200–2000 nodes)', () => {
    const fid = db.upsertFile('src/medium.ts', 'h1', 'typescript', 100, 1000).id;
    for (let i = 0; i < 500; i++) {
      db.insertNode(fid, `fn_${i}`, `src/medium.ts::fn_${i}`, 'function', i + 1, i + 1, `function fn_${i}()`, null, false);
    }
    // BASE callers: { maxDepth: 3, maxNodes: 40 }, medium: no bonus/penalty
    const result = computeLimits(db, 'callers');
    expect(result.maxDepth).toBe(3);
    expect(result.maxNodes).toBe(40);
  });

  it('applies large-repo depth penalty for >2000 nodes', () => {
    const fid = db.upsertFile('src/large.ts', 'h1', 'typescript', 100, 1000).id;
    for (let i = 0; i < 2100; i++) {
      db.insertNode(fid, `fn_${i}`, `src/large.ts::fn_${i}`, 'function', i + 1, i + 1, `function fn_${i}()`, null, false);
    }
    // BASE callers: { maxDepth: 3, maxNodes: 40 }, large: depthBonus -1, nodesBonus +30
    const result = computeLimits(db, 'callers');
    expect(result.maxDepth).toBe(2);
    expect(result.maxNodes).toBe(70);
  });

  it('clamps depth to minimum 1 for node tool on large repo', () => {
    // BASE node: { maxDepth: 1, maxNodes: 15 }, large: -1 depth → would be 0 → clamped to 1
    const fid = db.upsertFile('src/big.ts', 'h1', 'typescript', 100, 1000).id;
    for (let i = 0; i < 2100; i++) {
      db.insertNode(fid, `fn_${i}`, `src/big.ts::fn_${i}`, 'function', i + 1, i + 1, `function fn_${i}()`, null, false);
    }
    const result = computeLimits(db, 'node');
    expect(result.maxDepth).toBeGreaterThanOrEqual(1);
  });

  it('reduces depth for high-fan-out symbol (>20 edges)', () => {
    const fid = db.upsertFile('src/hub.ts', 'h1', 'typescript', 100, 1000).id;
    const hubId = db.insertNode(fid, 'hub', 'src/hub.ts::hub', 'function', 1, 1, 'function hub()', null, true);
    // Add 25 outgoing call edges to trigger high fan-out adjustment
    for (let i = 0; i < 25; i++) {
      const calleeId = db.insertNode(fid, `callee_${i}`, `src/hub.ts::callee_${i}`, 'function', i + 2, i + 2, `function callee_${i}()`, null, false);
      db.insertEdge(hubId, calleeId, 'calls');
    }
    // Small DB (< 200 nodes) base + small bonus: depth 3+1=4, then high fan-out -1 = 3
    const base = computeLimits(db, 'callers');
    const withHub = computeLimits(db, 'callers', { symbolName: 'hub' });
    expect(withHub.maxDepth).toBeLessThan(base.maxDepth);
  });

  it('increases depth for low-fan-out symbol (<5 edges)', () => {
    const fid = db.upsertFile('src/leaf.ts', 'h1', 'typescript', 100, 1000).id;
    db.insertNode(fid, 'leaf', 'src/leaf.ts::leaf', 'function', 1, 1, 'function leaf()', null, true);
    // 0 edges → fan-out < 5 → depthDelta +1
    const withoutSymbol = computeLimits(db, 'callers');
    const withLeaf = computeLimits(db, 'callers', { symbolName: 'leaf' });
    expect(withLeaf.maxDepth).toBeGreaterThanOrEqual(withoutSymbol.maxDepth);
  });

  it('returns different limits for different tool kinds', () => {
    const callers = computeLimits(db, 'callers');
    const impact  = computeLimits(db, 'impact');
    const context = computeLimits(db, 'context');
    // impact should allow deeper traversal than context
    expect(impact.maxDepth).toBeGreaterThan(context.maxDepth);
    expect(impact.maxNodes).toBeGreaterThan(callers.maxNodes);
  });
});
