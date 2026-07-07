import { GraphDB } from '../storage';
import type { NodeRecord, EdgeRecord, TraverseOptions, TraverseResult } from '../types';

export function traverse(
  db: GraphDB,
  startId: number,
  opts: TraverseOptions,
): TraverseResult {
  const visited = new Set<number>();
  const queue: { id: number; depth: number }[] = [{ id: startId, depth: 0 }];
  const resultNodes: (NodeRecord & { file_path: string; depth: number })[] = [];
  const resultEdges: EdgeRecord[] = [];
  let truncated = false;

  const kinds = opts.edgeKinds ?? [];
  const needForward = opts.direction === 'forward' || opts.direction === 'both';
  const needBackward = opts.direction === 'backward' || opts.direction === 'both';

  const outMaps: Map<number, EdgeRecord[]>[] = [];
  const inMaps: Map<number, EdgeRecord[]>[] = [];
  if (kinds.length > 0) {
    for (const k of kinds) {
      const { outgoing, incoming } = db.getAdjacencyMaps(k);
      if (needForward) outMaps.push(outgoing);
      if (needBackward) inMaps.push(incoming);
    }
  } else {
    const { outgoing, incoming } = db.getAdjacencyMaps();
    if (needForward) outMaps.push(outgoing);
    if (needBackward) inMaps.push(incoming);
  }

  function edgesFrom(id: number): EdgeRecord[] {
    const out: EdgeRecord[] = [];
    for (const m of outMaps) {
      const e = m.get(id);
      if (e) out.push(...e);
    }
    return out;
  }

  function edgesTo(id: number): EdgeRecord[] {
    const inc: EdgeRecord[] = [];
    for (const m of inMaps) {
      const e = m.get(id);
      if (e) inc.push(...e);
    }
    return inc;
  }

  const nodeMap = db.getNodeMap();
  const fileMap = db.getFileMap();

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id)) continue;
    if (depth > opts.maxDepth) continue;
    if (resultNodes.length >= opts.maxNodes) {
      truncated = true;
      break;
    }

    visited.add(id);

    const node = nodeMap.get(id) ?? db.getNode(id);
    if (!node) continue;
    const filePath = fileMap.get(node.file_id)?.path ?? '';
    resultNodes.push({ ...node, file_path: filePath, depth });

    const neighbors: { nodeId: number; edge: EdgeRecord }[] = [];
    if (needForward) for (const e of edgesFrom(id)) neighbors.push({ nodeId: e.target_id, edge: e });
    if (needBackward) for (const e of edgesTo(id)) neighbors.push({ nodeId: e.source_id, edge: e });

    for (const { nodeId, edge } of neighbors) {
      if (!visited.has(nodeId)) {
        resultEdges.push(edge);
        queue.push({ id: nodeId, depth: depth + 1 });
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges, truncated };
}

export function findCallers(
  db: GraphDB,
  symbolName: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): TraverseResult {
  const nodes = db.findNodesByName(symbolName);
  if (nodes.length === 0) return { nodes: [], edges: [], truncated: false };

  const { outgoing, incoming } = db.getAdjacencyMaps('calls');
  const target = nodes.reduce((best, n) => {
    const nExp = n.exported ?? 0;
    const bExp = best.exported ?? 0;
    if (nExp !== bExp) return nExp > bExp ? n : best;
    const c = (outgoing.get(n.id)?.length ?? 0) + (incoming.get(n.id)?.length ?? 0);
    const b = (outgoing.get(best.id)?.length ?? 0) + (incoming.get(best.id)?.length ?? 0);
    return c > b ? n : best;
  });
  return traverse(db, target.id, {
    maxDepth: opts.maxDepth ?? 3,
    maxNodes: opts.maxNodes ?? 50,
    direction: 'backward',
    edgeKinds: ['calls'],
  });
}

export function findCallees(
  db: GraphDB,
  symbolName: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): TraverseResult {
  const nodes = db.findNodesByName(symbolName);
  if (nodes.length === 0) return { nodes: [], edges: [], truncated: false };

  const { outgoing, incoming } = db.getAdjacencyMaps('calls');
  const target = nodes.reduce((best, n) => {
    const nExp = n.exported ?? 0;
    const bExp = best.exported ?? 0;
    if (nExp !== bExp) return nExp > bExp ? n : best;
    const c = (outgoing.get(n.id)?.length ?? 0) + (incoming.get(n.id)?.length ?? 0);
    const b = (outgoing.get(best.id)?.length ?? 0) + (incoming.get(best.id)?.length ?? 0);
    return c > b ? n : best;
  });
  return traverse(db, target.id, {
    maxDepth: opts.maxDepth ?? 3,
    maxNodes: opts.maxNodes ?? 50,
    direction: 'forward',
    edgeKinds: ['calls'],
  });
}
