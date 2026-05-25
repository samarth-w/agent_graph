/**
 * Graph traversal engine — BFS/DFS with cycle detection and bounded expansion.
 *
 * Core guarantee: **no circular references** in output.
 * Visited-set prevents re-expansion; maxDepth + maxNodes cap output size.
 */
import fs from 'fs';
import path from 'path';
import { GraphDB } from './storage';
import type {
  NodeRecord, EdgeRecord, TraverseOptions, TraverseResult, EdgeKind,
  TraceResult, TraceHop, NodeDetail, TrailEntry, FileInfo,
  AutoContextResult, AutoContextSymbol, PlanValidation, CodebaseDNA,
} from './types';

// ─── BFS traversal ──────────────────────────────────────────────
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

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id)) continue;               // cycle guard
    if (depth > opts.maxDepth) continue;          // depth cap
    if (resultNodes.length >= opts.maxNodes) {    // node cap
      truncated = true;
      break;
    }

    visited.add(id);

    const node = db.getNode(id);
    if (!node) continue;
    const file = db.getFileById(node.file_id);
    resultNodes.push({
      ...node,
      file_path: file?.path ?? '',
      depth,
    });

    // Collect neighbors
    const neighbors: { nodeId: number; edge: EdgeRecord }[] = [];

    if (opts.direction === 'forward' || opts.direction === 'both') {
      const edges = opts.edgeKinds
        ? opts.edgeKinds.flatMap(k => db.getEdgesFrom(id, k))
        : db.getEdgesFrom(id);
      for (const e of edges) {
        neighbors.push({ nodeId: e.target_id, edge: e });
      }
    }

    if (opts.direction === 'backward' || opts.direction === 'both') {
      const edges = opts.edgeKinds
        ? opts.edgeKinds.flatMap(k => db.getEdgesTo(id, k))
        : db.getEdgesTo(id);
      for (const e of edges) {
        neighbors.push({ nodeId: e.source_id, edge: e });
      }
    }

    for (const { nodeId, edge } of neighbors) {
      if (!visited.has(nodeId)) {
        resultEdges.push(edge);
        queue.push({ id: nodeId, depth: depth + 1 });
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges, truncated };
}

// ─── callers: who calls this symbol? ────────────────────────────
export function findCallers(
  db: GraphDB,
  symbolName: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): TraverseResult {
  const nodes = db.findNodesByName(symbolName);
  if (nodes.length === 0) return { nodes: [], edges: [], truncated: false };

  // Prefer the node with the most incoming call edges (the real definition)
  const target = nodes.reduce((best, n) => {
    const c = db.getEdgesTo(n.id, 'calls').length + db.getEdgesFrom(n.id, 'calls').length;
    const b = db.getEdgesTo(best.id, 'calls').length + db.getEdgesFrom(best.id, 'calls').length;
    return c > b ? n : best;
  });
  return traverse(db, target.id, {
    maxDepth: opts.maxDepth ?? 3,
    maxNodes: opts.maxNodes ?? 50,
    direction: 'backward',
    edgeKinds: ['calls'],
  });
}

// ─── callees: what does this symbol call? ───────────────────────
export function findCallees(
  db: GraphDB,
  symbolName: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): TraverseResult {
  const nodes = db.findNodesByName(symbolName);
  if (nodes.length === 0) return { nodes: [], edges: [], truncated: false };

  const target = nodes.reduce((best, n) => {
    const c = db.getEdgesTo(n.id, 'calls').length + db.getEdgesFrom(n.id, 'calls').length;
    const b = db.getEdgesTo(best.id, 'calls').length + db.getEdgesFrom(best.id, 'calls').length;
    return c > b ? n : best;
  });
  return traverse(db, target.id, {
    maxDepth: opts.maxDepth ?? 3,
    maxNodes: opts.maxNodes ?? 50,
    direction: 'forward',
    edgeKinds: ['calls'],
  });
}

// ─── impact: what breaks if this changes? ───────────────────────
export function analyzeImpact(
  db: GraphDB,
  target: string,  // symbol name or file path
  opts: { maxDepth?: number; maxNodes?: number } = {},
): {
  target: string;
  impacted_nodes: (NodeRecord & { file_path: string; depth: number })[];
  impacted_files: string[];
  edges: EdgeRecord[];
  truncated: boolean;
} {
  // Try as symbol first
  let nodes = db.findNodesByName(target);

  // If no symbol match, try as file path
  if (nodes.length === 0) {
    const file = db.getFile(target);
    if (file) {
      nodes = db.getNodesForFile(file.id);
    }
  }

  if (nodes.length === 0) {
    return {
      target,
      impacted_nodes: [],
      impacted_files: [],
      edges: [],
      truncated: false,
    };
  }

  // Merge reverse traversals from all matching nodes
  const visited = new Set<number>();
  const allNodes: (NodeRecord & { file_path: string; depth: number })[] = [];
  const allEdges: EdgeRecord[] = [];
  let truncated = false;
  const maxNodes = opts.maxNodes ?? 50;

  for (const node of nodes) {
    if (allNodes.length >= maxNodes) { truncated = true; break; }

    const result = traverse(db, node.id, {
      maxDepth: opts.maxDepth ?? 3,
      maxNodes: maxNodes - allNodes.length,
      direction: 'backward',
      edgeKinds: ['calls', 'imports'],
    });

    for (const n of result.nodes) {
      if (!visited.has(n.id)) {
        visited.add(n.id);
        allNodes.push(n);
      }
    }
    allEdges.push(...result.edges);
    if (result.truncated) truncated = true;
  }

  const impactedFiles = [...new Set(allNodes.map(n => n.file_path))];

  return {
    target,
    impacted_nodes: allNodes,
    impacted_files: impactedFiles,
    edges: allEdges,
    truncated,
  };
}

// ─── find symbol ────────────────────────────────────────────────
export function findSymbol(
  db: GraphDB,
  name: string,
): (NodeRecord & { file_path: string; callers: number; callees: number })[] {
  const nodes = db.findNodesByName(name);
  return nodes.map(n => {
    const file = db.getFileById(n.file_id);
    return {
      ...n,
      file_path: file?.path ?? '',
      callers: db.getEdgesTo(n.id, 'calls').length,
      callees: db.getEdgesFrom(n.id, 'calls').length,
    };
  });
}

// ─── trace: BFS shortest path between two symbols ──────────────
export function tracePath(
  db: GraphDB,
  rootDir: string,
  fromName: string,
  toName: string,
  opts: { maxHops?: number; includeCode?: boolean } = {},
): TraceResult {
  const maxHops = opts.maxHops ?? 7;
  const fromNodes = db.findNodesByName(fromName);
  const toNodes = db.findNodesByName(toName);

  if (fromNodes.length === 0 || toNodes.length === 0) {
    return { from: fromName, to: toName, found: false, hops: [], total_hops: 0 };
  }

  const toIds = new Set(toNodes.map(n => n.id));

  // Try BFS from each source to each target, pick shortest
  let bestPath: Array<{ node: NodeRecord; edge: EdgeRecord | null }> | null = null;

  for (const fromNode of fromNodes.slice(0, 3)) {
    const parent = new Map<number, { prevId: number | null; edge: EdgeRecord | null; node: NodeRecord }>();
    parent.set(fromNode.id, { prevId: null, edge: null, node: fromNode });

    const queue: { id: number; depth: number }[] = [{ id: fromNode.id, depth: 0 }];
    let foundTarget: number | null = null;

    for (let h = 0; h < queue.length && parent.size < 2000; h++) {
      const { id, depth } = queue[h];
      if (depth > 0 && toIds.has(id)) { foundTarget = id; break; }
      if (depth >= maxHops) continue;

      // Follow call edges forward
      const edges = db.getEdgesFrom(id, 'calls');
      for (const e of edges) {
        if (!parent.has(e.target_id)) {
          const targetNode = db.getNode(e.target_id);
          if (targetNode) {
            parent.set(e.target_id, { prevId: id, edge: e, node: targetNode });
            queue.push({ id: e.target_id, depth: depth + 1 });
          }
        }
      }
    }

    if (foundTarget !== null) {
      // Reconstruct path
      const chain: Array<{ node: NodeRecord; edge: EdgeRecord | null }> = [];
      let cur: number | null = foundTarget;
      while (cur !== null) {
        const p = parent.get(cur);
        if (!p) break;
        chain.push({ node: p.node, edge: p.edge });
        cur = p.prevId;
      }
      chain.reverse();

      if (!bestPath || chain.length < bestPath.length) {
        bestPath = chain;
      }
    }
  }

  if (!bestPath) {
    return { from: fromName, to: toName, found: false, hops: [], total_hops: 0 };
  }

  const hops: TraceHop[] = bestPath.map((step, i) => {
    const file = db.getFileById(step.node.file_id);
    const filePath = file?.path ?? '';
    const hop: TraceHop = {
      name: step.node.name,
      qualified_name: step.node.qualified_name,
      kind: step.node.kind,
      file: filePath,
      start_line: step.node.start_line,
      end_line: step.node.end_line,
      edge_kind: i === 0 ? null : (step.edge?.kind ?? 'calls'),
    };

    if (opts.includeCode) {
      hop.code = readSourceRange(rootDir, filePath, step.node.start_line, step.node.end_line, 40);
    }

    return hop;
  });

  return {
    from: fromName,
    to: toName,
    found: true,
    hops,
    total_hops: hops.length,
  };
}

// ─── node detail with trail ────────────────────────────────────
export function getNodeDetail(
  db: GraphDB,
  rootDir: string,
  symbolName: string,
  opts: { includeCode?: boolean; maxTrail?: number; maxSnippetLines?: number } = {},
): NodeDetail | null {
  const nodes = db.findNodesByName(symbolName);
  if (nodes.length === 0) return null;

  const node = nodes[0];
  const file = db.getFileById(node.file_id);
  const filePath = file?.path ?? '';

  // Build trail
  const callerEdges = db.getEdgesTo(node.id, 'calls');
  const calleeEdges = db.getEdgesFrom(node.id, 'calls');

  const callers: TrailEntry[] = [];
  const seen = new Set<number>();
  for (const e of callerEdges) {
    if (seen.has(e.source_id)) continue;
    seen.add(e.source_id);
    const n = db.getNode(e.source_id);
    if (!n) continue;
    const f = db.getFileById(n.file_id);
    callers.push({ name: n.name, kind: n.kind, file: f?.path ?? '', line: n.start_line });
  }

  const callees: TrailEntry[] = [];
  seen.clear();
  for (const e of calleeEdges) {
    if (seen.has(e.target_id)) continue;
    seen.add(e.target_id);
    const n = db.getNode(e.target_id);
    if (!n) continue;
    const f = db.getFileById(n.file_id);
    callees.push({ name: n.name, kind: n.kind, file: f?.path ?? '', line: n.start_line });
  }

  const detail: NodeDetail = {
    name: node.name,
    qualified_name: node.qualified_name,
    kind: node.kind,
    role: node.role,
    file: filePath,
    start_line: node.start_line,
    end_line: node.end_line,
    signature: node.signature,
    doc: node.doc,
    exported: node.exported === 1,
    trail: { callers: callers.slice(0, opts.maxTrail ?? 15), callees: callees.slice(0, opts.maxTrail ?? 15) },
  };

  if (opts.includeCode) {
    detail.code = readSourceRange(rootDir, filePath, node.start_line, node.end_line, opts.maxSnippetLines ?? 60);
  }

  return detail;
}

// ─── files listing from index ──────────────────────────────────
export function getIndexedFiles(
  db: GraphDB,
  opts: { path?: string; pattern?: string; format?: 'flat' | 'tree' | 'grouped' } = {},
): FileInfo[] {
  let files = db.getAllFiles();

  if (opts.path) {
    files = files.filter(f => f.path.startsWith(opts.path!));
  }

  if (opts.pattern) {
    const re = globToRegex(opts.pattern);
    files = files.filter(f => re.test(f.path));
  }

  return files.map(f => {
    const nodeCount = db.getNodesForFile(f.id).length;
    return { path: f.path, language: f.language, symbol_count: nodeCount };
  });
}

// ─── affected: find test files impacted by changes ─────────────
export function findAffected(
  db: GraphDB,
  changedFiles: string[],
  opts: { depth?: number; testPattern?: string } = {},
): { changed_files: string[]; affected_tests: string[]; total_affected: number; depth: number } {
  const depth = opts.depth ?? 5;
  const testRe = opts.testPattern
    ? globToRegex(opts.testPattern)
    : /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py)$|__tests?__\//i;

  // Find all nodes in changed files
  const seedIds = new Set<number>();
  for (const filePath of changedFiles) {
    const file = db.getFile(filePath);
    if (!file) continue;
    for (const n of db.getNodesForFile(file.id)) {
      seedIds.add(n.id);
    }
  }

  // BFS backward through call/import edges
  const visited = new Set<number>();
  const queue: { id: number; d: number }[] = [];
  for (const id of seedIds) {
    queue.push({ id, d: 0 });
    visited.add(id);
  }

  const impactedFileIds = new Set<number>();
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    const node = db.getNode(id);
    if (node) impactedFileIds.add(node.file_id);
    if (d >= depth) continue;

    for (const e of db.getEdgesTo(id, 'calls')) {
      if (!visited.has(e.source_id)) {
        visited.add(e.source_id);
        queue.push({ id: e.source_id, d: d + 1 });
      }
    }
    for (const e of db.getEdgesTo(id, 'imports')) {
      if (!visited.has(e.source_id)) {
        visited.add(e.source_id);
        queue.push({ id: e.source_id, d: d + 1 });
      }
    }
  }

  // Collect impacted file paths, filter to tests
  const affectedTests: string[] = [];
  for (const fid of impactedFileIds) {
    const f = db.getFileById(fid);
    if (f && testRe.test(f.path)) {
      affectedTests.push(f.path);
    }
  }

  return {
    changed_files: changedFiles,
    affected_tests: [...new Set(affectedTests)].sort(),
    total_affected: affectedTests.length,
    depth,
  };
}

// ─── helpers ────────────────────────────────────────────────────
function readSourceRange(
  rootDir: string, filePath: string,
  startLine: number, endLine: number, maxLines: number,
): string | undefined {
  try {
    const abs = path.resolve(rootDir, filePath);
    if (!fs.existsSync(abs)) return undefined;
    const lines = fs.readFileSync(abs, 'utf-8').split('\n');
    const s = Math.max(0, startLine - 1);
    let e = Math.min(lines.length, endLine);
    if (e - s > maxLines) e = s + maxLines;
    return lines.slice(s, e).join('\n');
  } catch {
    return undefined;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped, 'i');
}

// ─── dead code detection ────────────────────────────────────────
export interface DeadCodeResult {
  dead_symbols: { name: string; kind: string; file: string; line: number; signature: string | null }[];
  total: number;
  by_kind: Record<string, number>;
  by_file: Record<string, number>;
}

export function findDeadCode(
  db: GraphDB,
  opts: { kind?: string; file?: string; limit?: number } = {},
): DeadCodeResult {
  const allNodes = db.getAllNodes();
  let dead: typeof allNodes = [];

  for (const node of allNodes) {
    if (node.role !== 'dead') continue;
    dead.push(node);
  }

  if (opts.kind) {
    dead = dead.filter(n => n.kind === opts.kind);
  }

  if (opts.file) {
    dead = dead.filter(n => {
      const f = db.getFileById(n.file_id);
      return f && f.path.includes(opts.file!);
    });
  }

  const byKind: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  const symbols = dead.map(n => {
    const f = db.getFileById(n.file_id);
    const fp = f?.path ?? '';
    byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    byFile[fp] = (byFile[fp] || 0) + 1;
    return { name: n.name, kind: n.kind, file: fp, line: n.start_line, signature: n.signature };
  });

  const limit = opts.limit ?? 100;
  return {
    dead_symbols: symbols.slice(0, limit),
    total: symbols.length,
    by_kind: byKind,
    by_file: byFile,
  };
}

// ─── cycle detection ────────────────────────────────────────────
export interface CycleResult {
  cycles: { path: string[]; files: string[]; length: number }[];
  total: number;
  files_with_cycles: string[];
}

export function findCycles(
  db: GraphDB,
  opts: { maxCycles?: number; edgeKinds?: EdgeKind[] } = {},
): CycleResult {
  const maxCycles = opts.maxCycles ?? 50;
  const edgeKinds = opts.edgeKinds ?? ['calls', 'imports'];
  const allNodes = db.getAllNodes();

  const cycles: { path: string[]; files: string[]; length: number }[] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  const parent = new Map<number, number>();

  // Build adjacency from specified edge kinds using bulk query
  const adj = new Map<number, number[]>();
  for (const kind of edgeKinds) {
    const { outgoing } = db.getAdjacencyMaps(kind);
    for (const [nodeId, edges] of outgoing) {
      const existing = adj.get(nodeId) ?? [];
      for (const e of edges) existing.push(e.target_id);
      adj.set(nodeId, existing);
    }
  }
  for (const node of allNodes) {
    if (!adj.has(node.id)) adj.set(node.id, []);
    color.set(node.id, WHITE);
  }

  // DFS cycle detection
  const nodeMap = new Map(allNodes.map(n => [n.id, n]));
  const fileMap = db.getFileMap();

  function dfs(u: number, stack: number[]): void {
    if (cycles.length >= maxCycles) return;
    color.set(u, GRAY);
    stack.push(u);

    for (const v of (adj.get(u) ?? [])) {
      if (cycles.length >= maxCycles) return;
      if (color.get(v) === GRAY) {
        // Found cycle — extract from stack
        const cycleStart = stack.indexOf(v);
        if (cycleStart >= 0) {
          const cycleIds = stack.slice(cycleStart);
          const cyclePath = cycleIds.map(id => nodeMap.get(id)?.qualified_name ?? String(id));
          const cycleFiles = [...new Set(cycleIds.map(id => {
            const n = nodeMap.get(id);
            if (!n) return '';
            const f = fileMap.get(n.file_id);
            return f?.path ?? '';
          }).filter(Boolean))];

          // Deduplicate — normalize cycle by starting from smallest element
          const minIdx = cyclePath.indexOf([...cyclePath].sort()[0]);
          const normalized = [...cyclePath.slice(minIdx), ...cyclePath.slice(0, minIdx)];
          const key = normalized.join(' → ');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({ path: [...normalized, normalized[0]], files: cycleFiles, length: normalized.length });
          }
        }
      } else if (color.get(v) === WHITE) {
        dfs(v, stack);
      }
    }

    stack.pop();
    color.set(u, BLACK);
  }

  const seen = new Set<string>();
  for (const node of allNodes) {
    if (color.get(node.id) === WHITE && cycles.length < maxCycles) {
      dfs(node.id, []);
    }
  }

  const filesWithCycles = [...new Set(cycles.flatMap(c => c.files))].sort();
  return { cycles, total: cycles.length, files_with_cycles: filesWithCycles };
}

// ─── project stats / metrics ────────────────────────────────────
export interface ProjectStats {
  total_files: number;
  total_nodes: number;
  total_edges: number;
  avg_fan_in: number;
  avg_fan_out: number;
  max_fan_in: { symbol: string; file: string; count: number };
  max_fan_out: { symbol: string; file: string; count: number };
  hotspots: { symbol: string; file: string; fan_in: number; fan_out: number; coupling: number }[];
  file_coupling: { file: string; imports_from: number; imported_by: number; coupling: number }[];
  complexity_distribution: Record<string, number>;
}

export function getProjectStats(
  db: GraphDB,
  opts: { limit?: number } = {},
): ProjectStats {
  const limit = opts.limit ?? 15;
  const allNodes = db.getAllNodes();
  const allFiles = db.getAllFiles();

  // Bulk-load maps
  const fileMap = db.getFileMap();
  const nodeMap = db.getNodeMap();
  const { outgoing: callOut, incoming: callIn } = db.getAdjacencyMaps('calls');

  let totalFanIn = 0, totalFanOut = 0;
  let maxIn = { symbol: '', file: '', count: 0 };
  let maxOut = { symbol: '', file: '', count: 0 };
  const nodeMetrics: { name: string; file: string; fanIn: number; fanOut: number }[] = [];

  for (const node of allNodes) {
    const fanIn = (callIn.get(node.id) ?? []).length;
    const fanOut = (callOut.get(node.id) ?? []).length;
    totalFanIn += fanIn;
    totalFanOut += fanOut;
    const fp = fileMap.get(node.file_id)?.path ?? '';

    if (fanIn > maxIn.count) maxIn = { symbol: node.name, file: fp, count: fanIn };
    if (fanOut > maxOut.count) maxOut = { symbol: node.name, file: fp, count: fanOut };
    nodeMetrics.push({ name: node.name, file: fp, fanIn, fanOut });
  }

  const n = allNodes.length || 1;
  const hotspots = nodeMetrics
    .map(m => ({ symbol: m.name, file: m.file, fan_in: m.fanIn, fan_out: m.fanOut, coupling: m.fanIn + m.fanOut }))
    .sort((a, b) => b.coupling - a.coupling)
    .slice(0, limit);

  // File-level coupling — using bulk maps
  const fileCoupling = new Map<string, { importsFrom: Set<string>; importedBy: Set<string> }>();
  for (const f of allFiles) {
    fileCoupling.set(f.path, { importsFrom: new Set(), importedBy: new Set() });
  }
  const allEdges = db.getAllEdges();
  for (const e of allEdges) {
    if (e.kind !== 'imports') continue;
    const srcNode = nodeMap.get(e.source_id);
    const tgtNode = nodeMap.get(e.target_id);
    if (!srcNode || !tgtNode) continue;
    const srcFile = fileMap.get(srcNode.file_id);
    const tgtFile = fileMap.get(tgtNode.file_id);
    if (!srcFile || !tgtFile || srcFile.path === tgtFile.path) continue;
    fileCoupling.get(srcFile.path)?.importsFrom.add(tgtFile.path);
    fileCoupling.get(tgtFile.path)?.importedBy.add(srcFile.path);
  }

  const fileCouplingArr = [...fileCoupling.entries()]
    .map(([file, data]) => ({
      file,
      imports_from: data.importsFrom.size,
      imported_by: data.importedBy.size,
      coupling: data.importsFrom.size + data.importedBy.size,
    }))
    .sort((a, b) => b.coupling - a.coupling)
    .slice(0, limit);

  // Complexity distribution (fan-out buckets)
  const dist: Record<string, number> = { '0': 0, '1-3': 0, '4-7': 0, '8-15': 0, '16+': 0 };
  for (const m of nodeMetrics) {
    if (m.fanOut === 0) dist['0']++;
    else if (m.fanOut <= 3) dist['1-3']++;
    else if (m.fanOut <= 7) dist['4-7']++;
    else if (m.fanOut <= 15) dist['8-15']++;
    else dist['16+']++;
  }

  return {
    total_files: allFiles.length,
    total_nodes: allNodes.length,
    total_edges: allEdges.length,
    avg_fan_in: Math.round((totalFanIn / n) * 100) / 100,
    avg_fan_out: Math.round((totalFanOut / n) * 100) / 100,
    max_fan_in: maxIn,
    max_fan_out: maxOut,
    hotspots,
    file_coupling: fileCouplingArr,
    complexity_distribution: dist,
  };
}

// ─── refactoring suggestions ────────────────────────────────────
export interface Suggestion {
  type: 'extract' | 'inline' | 'move' | 'dead' | 'split';
  symbol: string;
  file: string;
  line: number;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

export interface SuggestResult {
  suggestions: Suggestion[];
  total: number;
}

export function suggestRefactorings(
  db: GraphDB,
  opts: { symbol?: string; file?: string; limit?: number } = {},
): SuggestResult {
  const limit = opts.limit ?? 30;
  const suggestions: Suggestion[] = [];
  let allNodes = db.getAllNodes();

  // Optionally scope to a symbol or file
  if (opts.symbol) {
    const matches = db.findNodesByName(opts.symbol);
    if (matches.length > 0) allNodes = matches;
    else return { suggestions: [], total: 0 };
  }
  if (opts.file) {
    const file = db.getFile(opts.file);
    if (file) allNodes = db.getNodesForFile(file.id);
    else return { suggestions: [], total: 0 };
  }

  // Bulk-load maps
  const fileMap = db.getFileMap();
  const nodeMap = db.getNodeMap();
  const { outgoing: callOut, incoming: callIn } = db.getAdjacencyMaps('calls');

  for (const node of allNodes) {
    if (suggestions.length >= limit * 3) break; // over-collect for dedup

    const fp = fileMap.get(node.file_id)?.path ?? '';
    const fanIn = (callIn.get(node.id) ?? []).length;
    const fanOut = (callOut.get(node.id) ?? []).length;
    const bodyLines = (node.end_line ?? node.start_line) - node.start_line + 1;

    // 1. Extract method: long functions with high fan-out
    if (bodyLines > 50 && fanOut >= 5) {
      suggestions.push({
        type: 'extract',
        symbol: node.name,
        file: fp,
        line: node.start_line,
        reason: `${bodyLines} lines, ${fanOut} outgoing calls — consider splitting into smaller functions`,
        priority: bodyLines > 100 ? 'high' : 'medium',
      });
    }

    // 2. Inline candidate: single caller, small body, just delegates
    if (fanIn === 1 && fanOut <= 2 && bodyLines <= 10 && node.kind === 'function') {
      suggestions.push({
        type: 'inline',
        symbol: node.name,
        file: fp,
        line: node.start_line,
        reason: `Only 1 caller, ${bodyLines} lines — may be inlined`,
        priority: 'low',
      });
    }

    // 3. Move candidate: symbol used more by other files than its own
    if (fanIn >= 2) {
      const callers = callIn.get(node.id) ?? [];
      const sameFile = callers.filter(e => {
        const src = nodeMap.get(e.source_id);
        return src && src.file_id === node.file_id;
      }).length;
      const otherFile = callers.length - sameFile;
      // Find which external file uses it most
      if (otherFile > sameFile && otherFile >= 2) {
        const extCallerFiles = new Map<string, number>();
        for (const e of callers) {
          const src = nodeMap.get(e.source_id);
          if (src && src.file_id !== node.file_id) {
            const sf = fileMap.get(src.file_id);
            if (sf) extCallerFiles.set(sf.path, (extCallerFiles.get(sf.path) || 0) + 1);
          }
        }
        const topFile = [...extCallerFiles.entries()].sort((a, b) => b[1] - a[1])[0];
        if (topFile) {
          suggestions.push({
            type: 'move',
            symbol: node.name,
            file: fp,
            line: node.start_line,
            reason: `${otherFile}/${callers.length} callers are external; most from ${topFile[0]} (${topFile[1]} calls)`,
            priority: otherFile >= 4 ? 'high' : 'medium',
          });
        }
      }
    }

    // 4. Dead code
    if (fanIn === 0 && fanOut === 0 && !node.exported) {
      suggestions.push({
        type: 'dead',
        symbol: node.name,
        file: fp,
        line: node.start_line,
        reason: 'No callers, no callees, not exported — safe to remove',
        priority: 'medium',
      });
    }

    // 5. God function / split candidate: very high fan-out
    if (fanOut >= 10) {
      suggestions.push({
        type: 'split',
        symbol: node.name,
        file: fp,
        line: node.start_line,
        reason: `${fanOut} outgoing calls — orchestrator function, consider splitting responsibilities`,
        priority: fanOut >= 15 ? 'high' : 'medium',
      });
    }
  }

  // Deduplicate by symbol+type, sort by priority
  const seen = new Set<string>();
  const deduped = suggestions.filter(s => {
    const key = `${s.type}:${s.symbol}:${s.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  deduped.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return {
    suggestions: deduped.slice(0, limit),
    total: deduped.length,
  };
}

// ─── Auto Context (warm-start file awareness) ──────────────────
export function getAutoContext(db: GraphDB, filePath: string): AutoContextResult {
  const file = db.getFile(filePath);
  if (!file) {
    return { file: filePath, language: '', symbols: [], related_tests: [], imports_from: [], imported_by: [], stats: { total: 0, exported: 0, roles: {} } };
  }

  const nodes = db.getNodesForFile(file.id);
  const testRe = /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py)$|__tests?__\//i;
  const allFiles = db.getAllFiles();

  // Bulk-load maps to avoid N+1 queries
  const fileMap = db.getFileMap();
  const nodeMap = db.getNodeMap();
  const { outgoing: callOut, incoming: callIn } = db.getAdjacencyMaps('calls');
  const { outgoing: impOut, incoming: impIn } = db.getAdjacencyMaps('imports');

  // Build symbols with top callers/callees
  const symbols: AutoContextSymbol[] = [];
  const roles: Record<string, number> = {};
  let exported = 0;

  for (const node of nodes) {
    if (node.exported) exported++;
    if (node.role) roles[node.role] = (roles[node.role] || 0) + 1;

    const callersRaw = (callIn.get(node.id) ?? []).slice(0, 5);
    const calleesRaw = (callOut.get(node.id) ?? []).slice(0, 5);

    const callers = callersRaw.map(e => {
      const n = nodeMap.get(e.source_id);
      const f = n ? fileMap.get(n.file_id) : undefined;
      return { name: n?.name ?? '?', file: f?.path ?? '' };
    });
    const callees = calleesRaw.map(e => {
      const n = nodeMap.get(e.target_id);
      const f = n ? fileMap.get(n.file_id) : undefined;
      return { name: n?.name ?? '?', file: f?.path ?? '' };
    });

    symbols.push({
      name: node.name,
      kind: node.kind,
      role: node.role,
      line: node.start_line,
      exported: !!node.exported,
      callers,
      callees,
    });
  }

  // Find related test files
  const baseName = path.basename(filePath).replace(/\.[^.]+$/, '');
  const related_tests = allFiles
    .filter(f => testRe.test(f.path) && f.path.includes(baseName))
    .map(f => f.path);

  // File-level imports_from / imported_by (using bulk maps)
  const importsFrom = new Set<string>();
  const importedBy = new Set<string>();
  for (const node of nodes) {
    for (const e of (impOut.get(node.id) ?? [])) {
      const t = nodeMap.get(e.target_id);
      if (t) { const f = fileMap.get(t.file_id); if (f && f.id !== file.id) importsFrom.add(f.path); }
    }
    for (const e of (impIn.get(node.id) ?? [])) {
      const s = nodeMap.get(e.source_id);
      if (s) { const f = fileMap.get(s.file_id); if (f && f.id !== file.id) importedBy.add(f.path); }
    }
  }

  return {
    file: filePath,
    language: file.language,
    symbols,
    related_tests,
    imports_from: [...importsFrom],
    imported_by: [...importedBy],
    stats: { total: nodes.length, exported, roles },
  };
}

// ─── Plan Validation (change risk assessment) ──────────────────
export function validatePlan(
  db: GraphDB,
  changes: { symbols?: string[]; files?: string[] },
): PlanValidation {
  const targets: string[] = [];
  const impactedSet = new Map<number, { name: string; file: string; depth: number }>();
  const impactedFiles = new Set<string>();
  const affectedTests = new Set<string>();
  const warnings: string[] = [];
  const cycleRisks: string[] = [];
  const testRe = /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py)$|__tests?__\//i;

  // Collect target node IDs
  const targetNodes: NodeRecord[] = [];
  for (const sym of changes.symbols ?? []) {
    targets.push(sym);
    const matches = db.findNodesByName(sym);
    targetNodes.push(...matches);
  }
  for (const fp of changes.files ?? []) {
    targets.push(fp);
    const file = db.getFile(fp);
    if (file) targetNodes.push(...db.getNodesForFile(file.id));
  }

  // Impact analysis for each target
  for (const node of targetNodes) {
    const result = traverse(db, node.id, {
      maxDepth: 3,
      maxNodes: 50,
      direction: 'backward',
      edgeKinds: ['calls', 'imports'],
    });
    for (const n of result.nodes) {
      if (!impactedSet.has(n.id)) {
        impactedSet.set(n.id, { name: n.name, file: n.file_path, depth: n.depth });
        impactedFiles.add(n.file_path);
        if (testRe.test(n.file_path)) affectedTests.add(n.file_path);
      }
    }
    if (result.truncated) warnings.push(`Impact of ${node.name} was truncated (large blast radius)`);
  }

  // Check for cycles involving targets
  const cycleResult = findCycles(db, { maxCycles: 10 });
  for (const cycle of cycleResult.cycles) {
    for (const node of targetNodes) {
      if (cycle.path.includes(node.qualified_name)) {
        cycleRisks.push(`${node.name} is in a cycle: ${cycle.path.join(' → ')}`);
        break;
      }
    }
  }

  // Hub warnings
  for (const node of targetNodes) {
    const fanIn = db.getEdgesTo(node.id, 'calls').length;
    if (fanIn >= 5) warnings.push(`${node.name} has ${fanIn} callers — high-impact change`);
  }

  const riskScore = impactedSet.size;
  const risk_level = riskScore <= 5 ? 'low' : riskScore <= 20 ? 'medium' : 'high';

  return {
    targets,
    risk_level,
    risk_score: riskScore,
    impacted_symbols: [...impactedSet.values()].sort((a, b) => a.depth - b.depth),
    impacted_files: [...impactedFiles],
    affected_tests: [...affectedTests],
    warnings,
    cycle_risks: cycleRisks,
  };
}

// ─── Codebase DNA (fingerprint) ────────────────────────────────
export function getCodebaseDNA(db: GraphDB): CodebaseDNA {
  const allFiles = db.getAllFiles();
  const allNodes = db.getAllNodes();
  const allEdges = db.getAllEdges();

  // Bulk-load maps (3 queries instead of hundreds)
  const fileMap = db.getFileMap();
  const { outgoing: callOut, incoming: callIn } = db.getAdjacencyMaps('calls');

  // Language distribution
  const langCounts = new Map<string, number>();
  for (const f of allFiles) langCounts.set(f.language, (langCounts.get(f.language) || 0) + 1);
  const languages = [...langCounts.entries()]
    .map(([lang, files]) => ({ lang, files, percentage: Math.round(files / allFiles.length * 100) }))
    .sort((a, b) => b.files - a.files);

  // Frameworks from route nodes
  const frameworks = new Set<string>();
  for (const n of allNodes) {
    if (n.kind === 'route') {
      const parts = n.qualified_name.split('::');
      if (parts.length > 1) frameworks.add(parts[0]);
    }
  }

  // Architecture style heuristic
  const dirs = new Set(allFiles.map(f => f.path.split('/')[0]));
  const allDirs = new Set(allFiles.map(f => { const p = f.path.split('/'); return p.length > 1 ? p.slice(0, -1).join('/') : ''; }));
  const dirNames = [...allDirs].map(d => d.split('/').pop()?.toLowerCase() ?? '');
  let architecture_style = 'flat';
  const layeredDirs = ['services', 'controllers', 'models', 'routes', 'middleware', 'handlers', 'repositories'];
  const componentDirs = ['components', 'pages', 'features', 'views', 'screens', 'widgets'];
  const layeredScore = layeredDirs.filter(d => dirNames.includes(d)).length;
  const componentScore = componentDirs.filter(d => dirNames.includes(d)).length;
  if (layeredScore >= 2) architecture_style = 'layered (MVC / service-oriented)';
  else if (componentScore >= 2) architecture_style = 'component-based';
  else if (dirs.size <= 2) architecture_style = 'monolith';
  else architecture_style = 'modular';

  // Role distribution
  const roleDist: Record<string, number> = {};
  for (const n of allNodes) {
    const r = n.role ?? 'unknown';
    roleDist[r] = (roleDist[r] || 0) + 1;
  }

  // Health scores (0-100) — using bulk maps instead of per-node queries
  const cycleResult = findCycles(db, { maxCycles: 50 });
  const deadCount = allNodes.filter(n => n.role === 'dead').length;
  const testRe = /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py)$|__tests?__\//i;
  const testFiles = allFiles.filter(f => testRe.test(f.path)).length;
  const sourceFiles = allFiles.length - testFiles;
  const godCount = allNodes.filter(n => {
    return (callOut.get(n.id) ?? []).length >= 10;
  }).length;

  const modularity = Math.max(0, Math.min(100, 100 - cycleResult.total * 10));
  const dead_code = allNodes.length > 0 ? Math.max(0, Math.min(100, 100 - Math.round(deadCount / allNodes.length * 200))) : 100;
  const test_coverage = sourceFiles > 0 ? Math.min(100, Math.round(testFiles / sourceFiles * 100)) : 0;
  const complexity = allNodes.length > 0 ? Math.max(0, Math.min(100, 100 - Math.round(godCount / allNodes.length * 1000))) : 100;
  const overall = Math.round((modularity + dead_code + test_coverage + complexity) / 4);

  // Key hubs — using bulk maps
  const key_hubs = allNodes
    .map(n => ({
      name: n.name,
      file: fileMap.get(n.file_id)?.path ?? '',
      fan_in: (callIn.get(n.id) ?? []).length,
      fan_out: (callOut.get(n.id) ?? []).length,
    }))
    .filter(h => h.fan_in >= 3 || h.fan_out >= 5)
    .sort((a, b) => (b.fan_in + b.fan_out) - (a.fan_in + a.fan_out))
    .slice(0, 10);

  // Summary
  const primaryLang = languages[0]?.lang ?? 'unknown';
  const summary = `${primaryLang}-dominant codebase with ${allFiles.length} files, ${allNodes.length} symbols, and ${allEdges.length} edges. ` +
    `Architecture style: ${architecture_style}. ` +
    `Health: modularity ${modularity}/100, dead code ${dead_code}/100, test coverage ${test_coverage}/100, complexity ${complexity}/100 (overall ${overall}/100). ` +
    `${cycleResult.total} circular dependencies detected. ${deadCount} dead symbols. ${key_hubs.length} hub functions.`;

  return {
    languages,
    frameworks: [...frameworks],
    architecture_style,
    health: { modularity, dead_code, test_coverage, complexity, overall },
    size: { files: allFiles.length, symbols: allNodes.length, edges: allEdges.length },
    role_distribution: roleDist,
    key_hubs,
    summary,
  };
}
