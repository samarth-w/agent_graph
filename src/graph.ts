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
