/**
 * Context builder — assembles a minimal, bounded context payload for agents.
 *
 * Flow: FTS search → graph expansion (bounded) → snippet extraction → JSON payload
 *
 * Guarantees:
 *  - No circular references (visited set)
 *  - Bounded output (maxNodes, maxDepth, maxSnippets, maxSnippetLines)
 *  - Estimated token count
 */
import fs from 'fs';
import path from 'path';
import { GraphDB } from './storage';
import { traverse } from './graph';
import { searchSymbols } from './search';
import { computeLimits } from './adaptive';
import { LRUCache } from './cache';
import { DEFAULT_CONFIG, estimateTokens } from './config';
import type {
  ContextPayload, ContextNode, ContextEdge, Snippet, ContextStats,
  GraphConfig, NodeRecord, ExploreResult, ExploreFileGroup, ExploreRelationship,
} from './types';

/** In-memory file content cache — proper LRU, avoids repeated readFileSync per session */
const fileContentCache = new LRUCache<string | null>(200, 5 * 60_000);

function readFileCached(absPath: string): string | null {
  const cached = fileContentCache.get(absPath);
  if (cached !== undefined) return cached;
  let content: string | null;
  try {
    if (!fs.existsSync(absPath)) { fileContentCache.set(absPath, null); return null; }
    content = fs.readFileSync(absPath, 'utf-8');
  } catch { content = null; }
  fileContentCache.set(absPath, content);
  return content;
}

/** Clear cached file contents (call after re-index) */
export function clearFileCache(): void { fileContentCache.clear(); }

const TEST_FILE_RE = /[\\/](test|spec|__tests__|fixtures|samples|examples)[\\/]|\.test\.|\.spec\.|\.fixture\./i;
function isTestFile(fp: string): boolean { return TEST_FILE_RE.test(fp); }

// ─── pipeline helpers ───────────────────────────────────────────

/** Expand seed nodes through the graph, returning bounded node/edge maps */
function expandSeeds(
  db: GraphDB,
  searchResults: ReturnType<typeof searchSymbols>,
  cfg: GraphConfig,
  opts: Partial<GraphConfig>,
): {
  expandedNodes: Map<number, NodeRecord & { file_path: string; depth: number }>;
  expandedEdges: Map<string, { source_qname: string; target_qname: string; kind: string }>;
} {
  const expandedNodes: Map<number, NodeRecord & { file_path: string; depth: number }> = new Map();
  const expandedEdges: Map<string, { source_qname: string; target_qname: string; kind: string }> = new Map();
  const nodeMap = db.getNodeMap();

  const adaptive    = computeLimits(db, 'context', { symbolName: searchResults[0]?.node?.name });
  const perSeedDepth    = opts.maxDepth  !== undefined ? Math.min(opts.maxDepth,  adaptive.maxDepth)  : adaptive.maxDepth;
  const perSeedMaxNodes = opts.maxNodes  !== undefined ? Math.min(opts.maxNodes,  adaptive.maxNodes)  : adaptive.maxNodes;

  for (const sr of searchResults) {
    if (expandedNodes.size >= cfg.maxNodes) break;
    const result = traverse(db, sr.node.id, {
      maxDepth: perSeedDepth,
      maxNodes: Math.min(cfg.maxNodes - expandedNodes.size, perSeedMaxNodes),
      direction: 'both',
    });
    for (const n of result.nodes) {
      if (!expandedNodes.has(n.id)) expandedNodes.set(n.id, n);
    }
    for (const e of result.edges) {
      const src = nodeMap.get(e.source_id);
      const tgt = nodeMap.get(e.target_id);
      if (src && tgt) {
        const key = `${e.source_id}-${e.target_id}-${e.kind}`;
        if (!expandedEdges.has(key)) {
          expandedEdges.set(key, { source_qname: src.qualified_name, target_qname: tgt.qualified_name, kind: e.kind });
        }
      }
    }
  }
  return { expandedNodes, expandedEdges };
}

/** Extract code snippets with per-file diversity cap */
function extractSnippets(
  db: GraphDB,
  rootDir: string,
  searchResults: ReturnType<typeof searchSymbols>,
  expandedNodes: Map<number, NodeRecord & { file_path: string; depth: number }>,
  cfg: GraphConfig,
): Snippet[] {
  const snippets: Snippet[] = [];
  const maxSnippetsPerFile = Math.max(1, Math.ceil(cfg.maxSnippets * 0.20));
  const snippetFileCounts  = new Map<string, number>();

  const candidates = [
    ...searchResults.map(r => r.node),
    ...[...expandedNodes.values()].filter(n => !searchResults.some(sr => sr.node.id === n.id)),
  ];

  for (const node of candidates) {
    if (snippets.length >= cfg.maxSnippets) break;
    const nodeFromMap = expandedNodes.get(node.id);
    const filePath = nodeFromMap?.file_path ?? db.getFileById(node.file_id)?.path;
    if (!filePath) continue;
    const sfc = snippetFileCounts.get(filePath) || 0;
    if (sfc >= maxSnippetsPerFile) continue;
    const absPath = path.resolve(rootDir, filePath);
    try {
      const content = readFileCached(absPath);
      if (!content) continue;
      const lines = content.split('\n');
      let startLine = node.start_line - 1;
      let endLine   = node.end_line;
      if (endLine - startLine > cfg.maxSnippetLines) endLine = startLine + cfg.maxSnippetLines;
      startLine = Math.max(0, startLine);
      endLine   = Math.min(lines.length, endLine);
      snippets.push({ file: filePath, start_line: startLine + 1, end_line: endLine, content: lines.slice(startLine, endLine).join('\n') });
      snippetFileCounts.set(filePath, sfc + 1);
    } catch { /* skip unreadable */ }
  }
  return snippets;
}


export function buildContext(
  db: GraphDB,
  rootDir: string,
  query: string,
  opts: Partial<GraphConfig> = {},
): ContextPayload {
  const cfg = { ...DEFAULT_CONFIG, ...opts };

  // 1. Search for seed nodes
  const searchResults = searchSymbols(db, query, { limit: 10 });

  // Co-location boost: files with multiple seeds rank higher
  const seedFileCounts = new Map<string, number>();
  for (const sr of searchResults) {
    const fp = db.getFileById(sr.node.file_id)?.path ?? '';
    if (fp) seedFileCounts.set(fp, (seedFileCounts.get(fp) || 0) + 1);
  }

  // 2. Graph expansion
  const { expandedNodes, expandedEdges } = expandSeeds(db, searchResults, cfg, opts);

  // 3. Build output nodes with co-location boost, per-file diversity cap, test-file cap
  const MAX_FILE_PCT = 0.20;
  const MAX_TEST_PCT = 0.15;
  const maxPerFile   = Math.max(1, Math.ceil(expandedNodes.size * MAX_FILE_PCT));
  const maxTestNodes = Math.max(2, Math.ceil(expandedNodes.size * MAX_TEST_PCT));

  const nodeEntries = [...expandedNodes.entries()].sort(([, a], [, b]) => {
    const aScore = seedFileCounts.get(a.file_path) ?? 0;
    const bScore = seedFileCounts.get(b.file_path) ?? 0;
    if (bScore !== aScore) return bScore - aScore;
    return (isTestFile(a.file_path) ? 1 : 0) - (isTestFile(b.file_path) ? 1 : 0);
  });

  const fileNodeCounts = new Map<string, number>();
  let testNodeCount = 0;
  const contextNodes: ContextNode[] = [];
  for (const [, n] of nodeEntries) {
    const fc = fileNodeCounts.get(n.file_path) || 0;
    if (fc >= maxPerFile) continue;
    if (isTestFile(n.file_path)) {
      if (testNodeCount >= maxTestNodes) continue;
      testNodeCount++;
    }
    fileNodeCounts.set(n.file_path, fc + 1);
    contextNodes.push({ name: n.name, qualified_name: n.qualified_name, kind: n.kind, role: n.role,
      file: n.file_path, start_line: n.start_line, end_line: n.end_line, signature: n.signature });
  }

  // 4. Build edges
  const contextEdges: ContextEdge[] = [...expandedEdges.values()].map(e => ({
    source: e.source_qname, target: e.target_qname, kind: e.kind,
  }));

  // 5. Extract snippets
  const snippets = extractSnippets(db, rootDir, searchResults, expandedNodes, cfg);

  // 6. Stats
  const allFiles = new Set([...contextNodes.map(n => n.file), ...snippets.map(s => s.file)]);
  const tokenEst    = estimateTokens(JSON.stringify({ contextNodes, contextEdges, snippets }));
  const strongHits  = searchResults.filter(r => r.rank > 0).length;
  const confidence: 'high' | 'low' = (searchResults.length >= 2 && strongHits >= 1) ? 'high' : 'low';
  const stats: ContextStats = {
    total_nodes: contextNodes.length,
    total_edges: contextEdges.length,
    total_files: allFiles.size,
    estimated_tokens: tokenEst,
    confidence,
    edge_density: contextNodes.length > 0 ? contextEdges.length / contextNodes.length : 0,
  };

  return {
    query,
    nodes: contextNodes,
    edges: contextEdges,
    files: [...allFiles],
    snippets,
    stats,
  };
}

// ─── explore: multi-symbol deep dive ────────────────────────────
export function explore(
  db: GraphDB,
  rootDir: string,
  query: string,
  opts: { maxFiles?: number; maxCharsPerFile?: number; maxDepth?: number; maxNodes?: number } = {},
): ExploreResult {
  const maxFiles = opts.maxFiles ?? 12;
  const maxCharsPerFile = opts.maxCharsPerFile ?? 6000;
  const exploreDepth = opts.maxDepth ?? 2;
  const exploreNodes = opts.maxNodes ?? 50;

  // 1. Search for relevant symbols
  const results = searchSymbols(db, query, { limit: 30 });
  if (results.length === 0) {
    return { query, files: [], relationships: [], stats: { total_symbols: 0, total_files: 0, estimated_tokens: 0 } };
  }

  // 2. Expand through graph to capture related symbols
  const nodeMap = db.getNodeMap();
  const fileMap = db.getFileMap();
  const nodeMapLocal = new Map<number, NodeRecord & { file_path: string }>();
  const edgesCollected: { source_qname: string; target_qname: string; kind: string }[] = [];

  for (const sr of results.slice(0, 8)) {
    if (nodeMapLocal.size >= 200) break;
    const result = traverse(db, sr.node.id, {
      maxDepth: exploreDepth,
      maxNodes: Math.min(exploreNodes, 200 - nodeMapLocal.size),
      direction: 'both',
    });
    for (const n of result.nodes) {
      if (!nodeMapLocal.has(n.id)) {
        nodeMapLocal.set(n.id, { ...n, file_path: n.file_path });
      }
    }
    for (const e of result.edges) {
      const src = nodeMap.get(e.source_id);
      const tgt = nodeMap.get(e.target_id);
      if (src && tgt) {
        edgesCollected.push({
          source_qname: src.qualified_name,
          target_qname: tgt.qualified_name,
          kind: e.kind,
        });
      }
    }
  }

  // 3. Group nodes by file, score by relevance
  const fileGroups = new Map<string, {
    nodes: (NodeRecord & { file_path: string })[];
    score: number;
    language: string;
  }>();

  const entryIds = new Set(results.slice(0, 8).map(r => r.node.id));

  for (const [, node] of nodeMapLocal) {
    const fp = node.file_path;
    let group = fileGroups.get(fp);
    if (!group) {
      const fileRec = fileMap.get(node.file_id);
      group = { nodes: [], score: 0, language: fileRec?.language ?? '' };
      fileGroups.set(fp, group);
    }
    group.nodes.push(node);
    group.score += entryIds.has(node.id) ? 10 : 1;
  }

  // 4. Sort files by score, take top N
  const sortedFiles = [...fileGroups.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, maxFiles);

  // 5. Read source for each file group
  const exploreFiles: ExploreFileGroup[] = [];
  let totalChars = 0;

  for (const [filePath, group] of sortedFiles) {
    const absPath = path.resolve(rootDir, filePath);

    try {
      const content = readFileCached(absPath);
      if (!content) continue;
      const lines = content.split('\n');

      // Sort nodes by line, find contiguous ranges
      group.nodes.sort((a, b) => a.start_line - b.start_line);

      // Cluster nodes into ranges
      const ranges: { start: number; end: number }[] = [];
      for (const n of group.nodes) {
        const last = ranges[ranges.length - 1];
        if (last && n.start_line <= last.end + 10) {
          last.end = Math.max(last.end, n.end_line);
        } else {
          ranges.push({ start: n.start_line, end: n.end_line });
        }
      }

      // Extract source, cap per file
      const sections: string[] = [];
      let fileChars = 0;
      for (const r of ranges) {
        const s = Math.max(0, r.start - 1);
        const e = Math.min(lines.length, r.end);
        const section = lines.slice(s, e)
          .map((l, i) => `${s + i + 1}\t${l}`)
          .join('\n');
        if (fileChars + section.length > maxCharsPerFile) break;
        sections.push(section);
        fileChars += section.length;
      }

      const source = sections.join('\n...\n');
      totalChars += source.length;

      exploreFiles.push({
        file: filePath,
        language: group.language,
        symbols: group.nodes.map(n => ({
          name: n.name,
          kind: n.kind,
          line: n.start_line,
        })),
        source,
      });
    } catch {
      continue;
    }
  }

  // 6. Deduplicate relationships
  const relSeen = new Set<string>();
  const relationships: ExploreRelationship[] = [];
  for (const e of edgesCollected) {
    const key = `${e.source_qname}→${e.target_qname}:${e.kind}`;
    if (!relSeen.has(key)) {
      relSeen.add(key);
      relationships.push({ source: e.source_qname, target: e.target_qname, kind: e.kind });
    }
  }

  return {
    query,
    files: exploreFiles,
    relationships: relationships.slice(0, 100),
    stats: {
      total_symbols: nodeMapLocal.size,
      total_files: exploreFiles.length,
      estimated_tokens: estimateTokens(JSON.stringify(exploreFiles)),
    },
  };
}
