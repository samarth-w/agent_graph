import type { GraphDB } from '../storage';

export interface GraphSummary {
  files: number;
  nodes: number;
  edges: number;
  avg_out_degree: number;
  top_kinds: Array<{ kind: string; count: number }>;
}

export function summarizeGraph(db: GraphDB): GraphSummary {
  const files = db.getAllFiles();
  const nodes = db.getAllNodes();
  const edges = db.getAllEdges();

  const kindCounts = new Map<string, number>();
  for (const node of nodes) {
    const current = kindCounts.get(node.kind) ?? 0;
    kindCounts.set(node.kind, current + 1);
  }

  const topKinds = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const avgOutDegree = nodes.length === 0 ? 0 : edges.length / nodes.length;

  return {
    files: files.length,
    nodes: nodes.length,
    edges: edges.length,
    avg_out_degree: Number(avgOutDegree.toFixed(2)),
    top_kinds: topKinds,
  };
}
