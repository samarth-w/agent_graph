/**
 * Export graph data as Mermaid, DOT (Graphviz), or interactive HTML diagrams.
 */
import { GraphDB } from './storage';
import { traverse } from './graph';
import type { NodeRecord, EdgeRecord } from './types';

export type ExportFormat = 'mermaid' | 'dot' | 'html';

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

// ─── Interactive HTML export (D3 force graph) ──────────────────
export function toHtml(db: GraphDB, opts: ExportOptions = {}): string {
  const data = gatherData(db, opts);
  if (data.nodes.length === 0) return '<html><body>No nodes found</body></html>';

  const nodeIds = new Set(data.nodes.map(n => n.id));
  const filteredEdges = data.edges.filter(e =>
    nodeIds.has(e.source_id) && nodeIds.has(e.target_id)
  );

  // Build JSON data for D3
  const nodesJson = JSON.stringify(data.nodes.map(n => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    role: n.role,
    file: n.file_path,
    line: n.start_line,
    signature: n.signature,
  })));

  const edgesJson = JSON.stringify(filteredEdges.map(e => ({
    source: e.source_id,
    target: e.target_id,
    kind: e.kind,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>cgraph — Interactive Call Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; overflow: hidden; }
  svg { width: 100vw; height: 100vh; }
  .tooltip { position: absolute; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity 0.15s; max-width: 400px; }
  .tooltip .name { font-weight: 600; color: #58a6ff; font-size: 14px; }
  .tooltip .kind { color: #8b949e; }
  .tooltip .file { color: #7ee787; font-size: 11px; margin-top: 4px; }
  .tooltip .sig { color: #c9d1d9; font-size: 11px; margin-top: 4px; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
  .controls { position: absolute; top: 12px; right: 12px; display: flex; gap: 6px; }
  .controls button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .controls button:hover { background: #30363d; }
  .legend { position: absolute; bottom: 12px; left: 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; font-size: 11px; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>
<div class="tooltip" id="tooltip"></div>
<div class="controls">
  <button onclick="resetZoom()">Reset Zoom</button>
  <button onclick="toggleLabels()">Toggle Labels</button>
</div>
<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:#58a6ff"></div> function</div>
  <div class="legend-item"><div class="legend-dot" style="background:#f78166"></div> class</div>
  <div class="legend-item"><div class="legend-dot" style="background:#7ee787"></div> method</div>
  <div class="legend-item"><div class="legend-dot" style="background:#d2a8ff"></div> interface/type</div>
  <div class="legend-item"><div class="legend-dot" style="background:#ffa657"></div> other</div>
</div>
<svg id="graph"></svg>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const nodes = ${nodesJson};
const links = ${edgesJson};

const kindColor = {
  function: '#58a6ff', class: '#f78166', method: '#7ee787',
  interface: '#d2a8ff', type_alias: '#d2a8ff', enum: '#ffa657',
  struct: '#f78166', namespace: '#79c0ff', variable: '#ffa657',
  route: '#ff7b72', component: '#ff7b72',
};
const roleSize = { entry: 8, core: 10, utility: 6, leaf: 5, dead: 4 };

const svg = d3.select('#graph');
const width = window.innerWidth, height = window.innerHeight;
const g = svg.append('g');

// Zoom
const zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', e => g.attr('transform', e.transform));
svg.call(zoom);
window.resetZoom = () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);

let showLabels = true;
window.toggleLabels = () => { showLabels = !showLabels; label.attr('display', showLabels ? null : 'none'); };

// Tooltip
const tooltip = d3.select('#tooltip');

// Simulation
const sim = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(links).id(d => d.id).distance(60))
  .force('charge', d3.forceManyBody().strength(-120))
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collision', d3.forceCollide().radius(12));

// Edges
const link = g.append('g').selectAll('line').data(links).join('line')
  .attr('stroke', d => d.kind === 'imports' ? '#30363d' : '#484f58')
  .attr('stroke-width', d => d.kind === 'imports' ? 0.5 : 1)
  .attr('stroke-dasharray', d => d.kind === 'imports' ? '4,3' : null);

// Nodes
const node = g.append('g').selectAll('circle').data(nodes).join('circle')
  .attr('r', d => roleSize[d.role] || 6)
  .attr('fill', d => kindColor[d.kind] || '#ffa657')
  .attr('stroke', '#0d1117').attr('stroke-width', 1.5)
  .call(d3.drag().on('start', dragStart).on('drag', dragging).on('end', dragEnd))
  .on('mouseover', (e, d) => {
    tooltip.style('opacity', 1)
      .html('<div class="name">' + d.name + '</div><div class="kind">' + d.kind + ' (' + (d.role||'') + ')</div><div class="file">' + d.file + ':' + d.line + '</div>' + (d.signature ? '<div class="sig">' + d.signature + '</div>' : ''));
  })
  .on('mousemove', e => tooltip.style('left', (e.pageX+12)+'px').style('top', (e.pageY-12)+'px'))
  .on('mouseout', () => tooltip.style('opacity', 0));

// Labels
const label = g.append('g').selectAll('text').data(nodes).join('text')
  .text(d => d.name).attr('font-size', 9).attr('fill', '#8b949e')
  .attr('dx', 10).attr('dy', 3).style('pointer-events', 'none');

sim.on('tick', () => {
  link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  node.attr('cx', d => d.x).attr('cy', d => d.y);
  label.attr('x', d => d.x).attr('y', d => d.y);
});

function dragStart(e) { if (!e.active) sim.alphaTarget(0.3).restart(); e.subject.fx = e.subject.x; e.subject.fy = e.subject.y; }
function dragging(e) { e.subject.fx = e.x; e.subject.fy = e.y; }
function dragEnd(e) { if (!e.active) sim.alphaTarget(0); e.subject.fx = null; e.subject.fy = null; }
</script>
</body>
</html>`;
}
