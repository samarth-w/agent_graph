/**
 * Adaptive traversal limits — dynamically computes depth and maxNodes
 * based on codebase size, tool type, and symbol fan-out.
 *
 * Replaces hardcoded defaults so small projects go deeper and
 * large projects go wider without exploding.
 */
import { GraphDB } from './storage';

export type ToolKind =
  | 'callers'
  | 'callees'
  | 'impact'
  | 'trace'
  | 'context'
  | 'explore'
  | 'affected'
  | 'node';

export interface AdaptiveLimits {
  maxDepth: number;
  maxNodes: number;
}

// ─── Per-tool base defaults ────────────────────────────────────
const BASE_LIMITS: Record<ToolKind, AdaptiveLimits> = {
  callers:  { maxDepth: 3, maxNodes: 40 },
  callees:  { maxDepth: 3, maxNodes: 40 },
  impact:   { maxDepth: 4, maxNodes: 80 },   // deeper for transitive breakage
  trace:    { maxDepth: 8, maxNodes: 2000 },  // trace needs wide BFS
  context:  { maxDepth: 2, maxNodes: 30 },    // context must stay small
  explore:  { maxDepth: 3, maxNodes: 60 },
  affected: { maxDepth: 6, maxNodes: 500 },   // exhaustive
  node:     { maxDepth: 1, maxNodes: 15 },    // trail items
};

// ─── Codebase size tier ────────────────────────────────────────
interface SizeTier {
  label: 'small' | 'medium' | 'large';
  depthBonus: number;
  nodesBonus: number;
}

function getSizeTier(totalNodes: number): SizeTier {
  if (totalNodes < 200) {
    return { label: 'small', depthBonus: 1, nodesBonus: 20 };
  }
  if (totalNodes > 2000) {
    return { label: 'large', depthBonus: -1, nodesBonus: 30 };
  }
  return { label: 'medium', depthBonus: 0, nodesBonus: 0 };
}

// ─── Fan-out adjustment ────────────────────────────────────────
function getFanOutAdjustment(
  db: GraphDB,
  symbolName: string | undefined,
): { depthDelta: number; nodesDelta: number } {
  if (!symbolName) return { depthDelta: 0, nodesDelta: 0 };

  const nodes = db.findNodesByName(symbolName);
  if (nodes.length === 0) return { depthDelta: 0, nodesDelta: 0 };

  // Sum edges across all matching nodes
  let totalEdges = 0;
  for (const n of nodes) {
    totalEdges += db.getEdgesFrom(n.id).length + db.getEdgesTo(n.id).length;
  }
  const avgEdges = totalEdges / nodes.length;

  // High fan-out: go wider, not deeper
  if (avgEdges > 20) return { depthDelta: -1, nodesDelta: 20 };
  // Low fan-out: can afford to go deeper
  if (avgEdges < 5) return { depthDelta: 1, nodesDelta: 0 };

  return { depthDelta: 0, nodesDelta: 0 };
}

// ─── Main entry point ──────────────────────────────────────────
/**
 * Compute adaptive traversal limits for a tool call.
 *
 * Explicit user-provided values always override adaptive logic.
 * Pass `undefined` for values that should be computed adaptively.
 */
export function computeLimits(
  db: GraphDB,
  tool: ToolKind,
  opts: {
    symbolName?: string;
    explicitDepth?: number;
    explicitMaxNodes?: number;
  } = {},
): AdaptiveLimits {
  const base = BASE_LIMITS[tool];

  // If user provided explicit values, use them directly
  if (opts.explicitDepth !== undefined && opts.explicitMaxNodes !== undefined) {
    return { maxDepth: opts.explicitDepth, maxNodes: opts.explicitMaxNodes };
  }

  // Get codebase size
  const status = db.getStatus('.');
  const tier = getSizeTier(status.nodes_count);

  // Get fan-out adjustment
  const fanOut = getFanOutAdjustment(db, opts.symbolName);

  // Compute final values
  let maxDepth = base.maxDepth + tier.depthBonus + fanOut.depthDelta;
  let maxNodes = base.maxNodes + tier.nodesBonus + fanOut.nodesDelta;

  // Apply explicit overrides (partial)
  if (opts.explicitDepth !== undefined) maxDepth = opts.explicitDepth;
  if (opts.explicitMaxNodes !== undefined) maxNodes = opts.explicitMaxNodes;

  // Clamp to safe ranges
  maxDepth = Math.max(1, Math.min(maxDepth, 10));
  maxNodes = Math.max(5, Math.min(maxNodes, 2000));

  return { maxDepth, maxNodes };
}
