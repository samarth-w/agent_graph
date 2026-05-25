/**
 * Export graph data as Mermaid or DOT (Graphviz) diagrams.
 */
import { GraphDB } from './storage';
import { traverse } from './graph';
import type { NodeRecord, EdgeRecord } from './types';

export type ExportFormat = 'mermaid' | 'dot';

export interface ExportOptions {
  /** Start from a specific symbol (if omitted, exports whole graph) */
  symbol?: string;
  /** Max traversal depth when starting from a symbol */
  maxDepth?: number;
  /** Max nodes to include */
  maxNodes?: number;
  /** Direction for traversal */
  direction?: 'forward' | 'backward' | 'both';
}

interface GraphData {
  nodes: (NodeRecord & { file_path: string })[];
  edges: EdgeRecord[];
}

// ─── Gather graph data ─────────────────────────────────────────
function gatherData(db: GraphDB, opts: ExportOptions): GraphData {
  if (opts.symbol) {
    const found = db.findNodesByName(opts.symbol);
    if (found.length === 0) return { nodes: [], edges: [] };

    const result = traverse(db, found[0].id, {
      maxDepth: opts.maxDepth ?? 4,
      maxNodes: opts.maxNodes ?? 100,
      direction: opts.direction ?? 'both',
    });
    return { nodes: result.nodes, edges: result.edges };
  }

  // Whole graph — get all nodes and edges
  const rawNodes = db.getAllNodes();
  const allNodes = rawNodes.map(n => {
    const f = db.getFileById(n.file_id);
    return { ...n, file_path: f?.path ?? '' };
  });
  const allEdges = db.getAllEdges();

  const limit = opts.maxNodes ?? 200;
  return {
    nodes: allNodes.slice(0, limit),
    edges: allEdges.filter(e =>
      allNodes.some(n => n.id === e.source_id) &&
      allNodes.some(n => n.id === e.target_id)
    ),
  };
}

// ─── Sanitize ID for Mermaid/DOT ───────────────────────────────
function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

// ─── Shape by kind ─────────────────────────────────────────────
function mermaidShape(kind: string, label: string): string {
  const escaped = label.replace(/"/g, "'");
  switch (kind) {
    case 'class': return `[["${escaped}"]]`;
    case 'interface': return `(["${escaped}"])`;
    case 'function': case 'method': return `("${escaped}")`;
    case 'component': return `{{"${escaped}"}}`;
    default: return `["${escaped}"]`;
  }
}

function dotShape(kind: string): string {
  switch (kind) {
    case 'class': return 'box3d';
    case 'interface': return 'ellipse';
    case 'function': case 'method': return 'box';
    case 'component': return 'component';
    default: return 'box';
  }
}

// ─── Mermaid export ────────────────────────────────────────────
export function toMermaid(db: GraphDB, opts: ExportOptions = {}): string {
  const data = gatherData(db, opts);
  if (data.nodes.length === 0) return '%% No nodes found';

  const lines = ['graph LR'];

  // Group nodes by file
  const byFile = new Map<string, typeof data.nodes>();
  for (const n of data.nodes) {
    const arr = byFile.get(n.file_path) ?? [];
    arr.push(n);
    byFile.set(n.file_path, arr);
  }

  for (const [file, nodes] of byFile) {
    lines.push(`  subgraph ${sanitizeId(file)}["${file}"]`);
    for (const n of nodes) {
      const id = sanitizeId(n.qualified_name);
      lines.push(`    ${id}${mermaidShape(n.kind, n.name)}`);
    }
    lines.push('  end');
  }

  // Edges
  const nodeIds = new Set(data.nodes.map(n => n.id));
  for (const e of data.edges) {
    if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
    const src = data.nodes.find(n => n.id === e.source_id);
    const tgt = data.nodes.find(n => n.id === e.target_id);
    if (!src || !tgt) continue;
    const arrow = e.kind === 'imports' ? '-.->|imports|' : '-->|calls|';
    lines.push(`  ${sanitizeId(src.qualified_name)} ${arrow} ${sanitizeId(tgt.qualified_name)}`);
  }

  return lines.join('\n');
}

// ─── DOT export ────────────────────────────────────────────────
export function toDot(db: GraphDB, opts: ExportOptions = {}): string {
  const data = gatherData(db, opts);
  if (data.nodes.length === 0) return '// No nodes found';

  const lines = ['digraph cgraph {', '  rankdir=LR;', '  node [fontname="Helvetica" fontsize=10];'];

  // Group by file as subgraphs
  const byFile = new Map<string, typeof data.nodes>();
  for (const n of data.nodes) {
    const arr = byFile.get(n.file_path) ?? [];
    arr.push(n);
    byFile.set(n.file_path, arr);
  }

  let clusterIdx = 0;
  for (const [file, nodes] of byFile) {
    lines.push(`  subgraph cluster_${clusterIdx++} {`);
    lines.push(`    label="${file}";`);
    for (const n of nodes) {
      const id = sanitizeId(n.qualified_name);
      const shape = dotShape(n.kind);
      lines.push(`    ${id} [label="${n.name}" shape=${shape}];`);
    }
    lines.push('  }');
  }

  // Edges
  const nodeIds = new Set(data.nodes.map(n => n.id));
  for (const e of data.edges) {
    if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
    const src = data.nodes.find(n => n.id === e.source_id);
    const tgt = data.nodes.find(n => n.id === e.target_id);
    if (!src || !tgt) continue;
    const style = e.kind === 'imports' ? ' [style=dashed label="imports"]' : '';
    lines.push(`  ${sanitizeId(src.qualified_name)} -> ${sanitizeId(tgt.qualified_name)}${style};`);
  }

  lines.push('}');
  return lines.join('\n');
}
