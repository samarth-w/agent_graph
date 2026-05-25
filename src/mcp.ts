/**
 * MCP (Model Context Protocol) server for cgraph.
 *
 * Exposes graph tools over stdio JSON-RPC transport so AI agents
 * (Claude Code, Cursor, Codex CLI, etc.) can query the code graph.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout, one message per line.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { GraphDB } from './storage';
import { indexProject } from './indexer';
import { findCallers, findCallees, analyzeImpact, findSymbol, tracePath, getNodeDetail, getIndexedFiles, findAffected } from './graph';
import { searchSymbols } from './search';
import { buildContext, explore } from './context';
import { getDbPath, DB_DIR } from './config';
import { computeLimits } from './adaptive';
import { toMermaid, toDot, toHtml } from './export';
import { findChangedSymbols } from './git';
import { LRUCache } from './cache';
import { FileWatcher } from './watcher';
import type { McpToolDef, McpToolResult } from './types';

// ─── Input validation ──────────────────────────────────────────
const MAX_INPUT_LENGTH = 10_000;
const MAX_PATH_LENGTH = 1_000;

function validateString(value: unknown, name: string, maxLen = MAX_INPUT_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > maxLen) {
    throw new Error(`${name} exceeds max length of ${maxLen}`);
  }
  return value;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ─── Tool definitions ──────────────────────────────────────────
const TOOLS: McpToolDef[] = [
  {
    name: 'cgraph_search',
    description: 'Search symbols by name. Supports field qualifiers: kind:function lang:ts path:src/ name:handle. Returns locations only (no code).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name, partial name, or field-qualified query' },
        kind: { type: 'string', description: 'Filter by kind', enum: ['function','method','class','interface','type_alias','variable','enum','route','component'] },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'cgraph_context',
    description: 'PRIMARY TOOL — builds relevant code context for a task. Composes search + graph expansion + code snippets in ONE call. Use this first for architecture, feature, or bug questions.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task, bug, or feature' },
        maxNodes: { type: 'number', description: 'Max symbols to include (default: 20)', default: 20 },
        includeCode: { type: 'boolean', description: 'Include code snippets (default: true)', default: true },
      },
      required: ['task'],
    },
  },
  {
    name: 'cgraph_trace',
    description: 'Trace the call path between two symbols — "how does X reach Y?" Returns each hop with file:line and optional code. Grep cannot do this.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Symbol the flow starts at' },
        to: { type: 'string', description: 'Symbol the flow should reach' },
        includeCode: { type: 'boolean', description: 'Include source code for each hop', default: false },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'cgraph_explore',
    description: 'Returns source for SEVERAL related symbols grouped by file in ONE call. Use after cgraph_context when you need actual source code. Query with specific symbol/file names, not natural language.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol names or file names to explore' },
        maxFiles: { type: 'number', description: 'Max files to include source from (default: 12)', default: 12 },
      },
      required: ['query'],
    },
  },
  {
    name: 'cgraph_node',
    description: 'Get ONE symbol\'s details (location, signature, doc) plus its trail — what it calls and what calls it, each with file:line. Use to walk the call graph hop-by-hop.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Name of the symbol' },
        includeCode: { type: 'boolean', description: 'Include source code (default: false)', default: false },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'cgraph_callers',
    description: 'Find all callers of a symbol. Shows usage patterns and change impact.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Name of the function/method/class' },
        limit: { type: 'number', description: 'Max callers (default: 20)', default: 20 },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'cgraph_callees',
    description: 'Find all callees of a symbol. Shows dependencies and code flow.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Name of the function/method/class' },
        limit: { type: 'number', description: 'Max callees (default: 20)', default: 20 },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'cgraph_impact',
    description: 'Analyze impact radius of changing a symbol. Shows what code could break.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol to analyze' },
        depth: { type: 'number', description: 'Traversal depth (default: 2)', default: 2 },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'cgraph_files',
    description: 'Get indexed file structure. Faster than filesystem scanning. Shows language and symbol count per file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Filter to files under this directory' },
        pattern: { type: 'string', description: 'Glob pattern filter (e.g. "*.tsx", "**/*.test.ts")' },
        format: { type: 'string', description: 'Output format', enum: ['flat', 'tree', 'grouped'], default: 'flat' },
      },
    },
  },
  {
    name: 'cgraph_status',
    description: 'Get index health: file count, nodes, edges, languages, roles.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cgraph_affected',
    description: 'Find test files affected by changes to source files. Traces import dependencies transitively.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'string', description: 'Comma-separated list of changed file paths' },
        depth: { type: 'number', description: 'Max dependency depth (default: 5)', default: 5 },
        filter: { type: 'string', description: 'Custom glob to identify test files' },
      },
      required: ['files'],
    },
  },
  {
    name: 'cgraph_export',
    description: 'Export the code graph as a Mermaid or DOT (Graphviz) diagram. Optionally scope to a symbol and its neighborhood.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'Output format', enum: ['mermaid', 'dot', 'html'], default: 'mermaid' },
        symbol: { type: 'string', description: 'Center the diagram on this symbol (omit for whole graph)' },
        depth: { type: 'number', description: 'Traversal depth from symbol (default: 4)', default: 4 },
        maxNodes: { type: 'number', description: 'Max nodes to include (default: 100)', default: 100 },
        direction: { type: 'string', description: 'Traversal direction', enum: ['forward', 'backward', 'both'], default: 'both' },
      },
    },
  },
  {
    name: 'cgraph_changed',
    description: 'Find symbols changed in the current git diff. Maps changed lines to specific functions/classes in the graph. Use before cgraph_impact to see what changed and what might break.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to diff against (default: HEAD)', default: 'HEAD' },
        staged: { type: 'boolean', description: 'Only show staged changes', default: false },
      },
    },
  },
];

// ─── Tool handler ──────────────────────────────────────────────
class ToolHandler {
  private db: GraphDB | null = null;
  private syncing = false;
  private cache = new LRUCache<McpToolResult>(64, 30_000);
  private watcher: FileWatcher | null = null;
  private dirty = false; // set true by watcher, cleared after db swap

  constructor(private rootDir: string) {}

  private async getDb(): Promise<GraphDB> {
    if (!this.db) {
      const dbPath = getDbPath(this.rootDir);
      if (!fs.existsSync(dbPath)) {
        await indexProject(this.rootDir);
      }
      this.db = await GraphDB.open(dbPath);

      // Enable cache persistence
      this.cache.enablePersistence(path.join(this.rootDir, DB_DIR, 'cache.json'));

      // Start file watcher for incremental re-index
      if (!this.watcher) {
        this.watcher = new FileWatcher(this.rootDir, {
          debounceMs: 1500,
          onSync: async (result) => {
            if (result.files_changed > 0) {
              this.dirty = true;
            }
          },
          onError: () => { /* ignore watch errors */ },
        });
        this.watcher.start();
      }
    }

    // Swap to fresh db if watcher detected changes
    if (this.dirty && !this.syncing) {
      this.dirty = false;
      this.syncing = true;
      try {
        const fresh = await GraphDB.open(getDbPath(this.rootDir));
        const old = this.db;
        this.db = fresh;
        old?.close();
        this.cache.clear();
      } catch { /* keep old db */ }
      this.syncing = false;
    }

    return this.db;
  }

  // Tools that produce deterministic results from the same args
  private static CACHEABLE = new Set([
    'cgraph_search', 'cgraph_callers', 'cgraph_callees', 'cgraph_impact',
    'cgraph_node', 'cgraph_trace', 'cgraph_files', 'cgraph_status', 'cgraph_export',
  ]);

  async execute(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    // Check cache for deterministic tools
    const cacheKey = ToolHandler.CACHEABLE.has(toolName)
      ? `${toolName}:${JSON.stringify(args)}` : null;
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    try {
      let result: McpToolResult;
      switch (toolName) {
        case 'cgraph_search': result = await this.handleSearch(args); break;
        case 'cgraph_context': result = await this.handleContext(args); break;
        case 'cgraph_trace': result = await this.handleTrace(args); break;
        case 'cgraph_explore': result = await this.handleExplore(args); break;
        case 'cgraph_node': result = await this.handleNode(args); break;
        case 'cgraph_callers': result = await this.handleCallers(args); break;
        case 'cgraph_callees': result = await this.handleCallees(args); break;
        case 'cgraph_impact': result = await this.handleImpact(args); break;
        case 'cgraph_files': result = await this.handleFiles(args); break;
        case 'cgraph_status': result = await this.handleStatus(args); break;
        case 'cgraph_affected': result = await this.handleAffected(args); break;
        case 'cgraph_export': result = await this.handleExport(args); break;
        case 'cgraph_changed': result = await this.handleChanged(args); break;
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
      if (cacheKey && !result.isError) this.cache.set(cacheKey, result);
      return result;
    } catch (err: any) {
      return this.errorResult(err.message ?? String(err));
    }
  }

  private async handleSearch(args: Record<string, unknown>): Promise<McpToolResult> {
    const query = validateString(args.query, 'query');
    const db = await this.getDb();
    const limit = clamp(Number(args.limit) || 10, 1, 100);
    const results = searchSymbols(db, query, {
      limit,
      kind: args.kind as string | undefined,
    });
    if (results.length === 0) return this.textResult(`No results for "${query}"`);
    const lines = [`## Search Results (${results.length})`, ''];
    for (const r of results) {
      lines.push(`### ${r.node.name} (${r.node.kind})`);
      lines.push(`${r.file_path}:${r.node.start_line}`);
      if (r.node.signature) lines.push(`\`${r.node.signature}\``);
      lines.push('');
    }
    return this.textResult(lines.join('\n'));
  }

  private async handleContext(args: Record<string, unknown>): Promise<McpToolResult> {
    const task = validateString(args.task, 'task');
    const db = await this.getDb();
    const adaptive = computeLimits(db, 'context', {
      explicitMaxNodes: args.maxNodes != null ? clamp(Number(args.maxNodes), 1, 200) : undefined,
    });
    const payload = buildContext(db, this.rootDir, task, { maxNodes: adaptive.maxNodes });
    return this.textResult(JSON.stringify(payload, null, 2));
  }

  private async handleTrace(args: Record<string, unknown>): Promise<McpToolResult> {
    const from = validateString(args.from, 'from');
    const to = validateString(args.to, 'to');
    const db = await this.getDb();
    const result = tracePath(db, this.rootDir, from, to, {
      includeCode: args.includeCode === true,
    });
    if (!result.found) {
      return this.textResult(
        `No static call path from "${from}" to "${to}". ` +
        'The chain likely breaks at dynamic dispatch (callback, event, interface→impl). ' +
        `Use cgraph_node on "${from}" to see its callees and bridge the gap.`
      );
    }
    const lines = [`## Trace: ${from} → ${to}`, '', `${result.total_hops} hops:`, ''];
    for (let i = 0; i < result.hops.length; i++) {
      const hop = result.hops[i];
      if (hop.edge_kind) lines.push(`   ↓ ${hop.edge_kind}`);
      lines.push(`${i + 1}. ${hop.name} (${hop.file}:${hop.start_line}-${hop.end_line})`);
      if (hop.code) lines.push('```', hop.code, '```');
    }
    return this.textResult(lines.join('\n'));
  }

  private async handleExplore(args: Record<string, unknown>): Promise<McpToolResult> {
    const query = validateString(args.query, 'query');
    const db = await this.getDb();
    const adaptive = computeLimits(db, 'explore');
    const maxFiles = clamp(Number(args.maxFiles) || Math.min(adaptive.maxNodes, 20), 1, 20);
    const result = explore(db, this.rootDir, query, {
      maxFiles,
      maxDepth: adaptive.maxDepth,
      maxNodes: adaptive.maxNodes,
    });
    if (result.files.length === 0) return this.textResult(`No relevant code for "${query}"`);

    const lines = [`## Explore: ${query}`, ''];
    if (result.relationships.length > 0) {
      lines.push('### Relationships');
      const byKind = new Map<string, { s: string; t: string }[]>();
      for (const r of result.relationships) {
        const arr = byKind.get(r.kind) ?? [];
        arr.push({ s: r.source, t: r.target });
        byKind.set(r.kind, arr);
      }
      for (const [kind, edges] of byKind) {
        lines.push(`**${kind}:**`);
        for (const e of edges.slice(0, 10)) lines.push(`- ${e.s} → ${e.t}`);
        if (edges.length > 10) lines.push(`- ... and ${edges.length - 10} more`);
        lines.push('');
      }
    }
    lines.push('### Source Code', '');
    for (const fg of result.files) {
      const symbolList = fg.symbols.map(s => `${s.name}(${s.kind})`).join(', ');
      lines.push(`#### ${fg.file} — ${symbolList}`, '', '```' + fg.language, fg.source, '```', '');
    }
    lines.push(`> ${result.stats.total_files} files, ${result.stats.total_symbols} symbols, ~${result.stats.estimated_tokens} tokens`);
    return this.textResult(lines.join('\n'));
  }

  private async handleNode(args: Record<string, unknown>): Promise<McpToolResult> {
    const symbol = validateString(args.symbol, 'symbol');
    const db = await this.getDb();
    const adaptive = computeLimits(db, 'node', { symbolName: symbol });
    const detail = getNodeDetail(db, this.rootDir, symbol, {
      includeCode: args.includeCode === true,
      maxTrail: adaptive.maxNodes,
    });
    if (!detail) return this.textResult(`Symbol "${symbol}" not found`);

    const lines = [
      `## ${detail.name} (${detail.kind})`, '',
      `**Location:** ${detail.file}:${detail.start_line}-${detail.end_line}`,
    ];
    if (detail.signature) lines.push(`**Signature:** \`${detail.signature}\``);
    if (detail.role) lines.push(`**Role:** ${detail.role}`);
    if (detail.doc) lines.push('', detail.doc);
    if (detail.code) lines.push('', '```', detail.code, '```');

    if (detail.trail.callees.length > 0 || detail.trail.callers.length > 0) {
      lines.push('', '### Trail');
      if (detail.trail.callees.length > 0) {
        lines.push(`**Calls →** ${detail.trail.callees.map(c => `${c.name} (${c.file}:${c.line})`).join(', ')}`);
      }
      if (detail.trail.callers.length > 0) {
        lines.push(`**Called by ←** ${detail.trail.callers.map(c => `${c.name} (${c.file}:${c.line})`).join(', ')}`);
      }
    }
    return this.textResult(lines.join('\n'));
  }

  private async handleCallers(args: Record<string, unknown>): Promise<McpToolResult> {
    const symbol = validateString(args.symbol, 'symbol');
    const db = await this.getDb();
    const adaptive = computeLimits(db, 'callers', {
      symbolName: symbol,
      explicitMaxNodes: args.limit != null ? clamp(Number(args.limit), 1, 100) : undefined,
    });
    const result = findCallers(db, symbol, { maxNodes: adaptive.maxNodes, maxDepth: adaptive.maxDepth });
    const callers = result.nodes.filter(n => n.name !== symbol);
    if (callers.length === 0) return this.textResult(`No callers found for "${symbol}"`);
    return this.textResult(this.formatNodeList(callers, `Callers of ${symbol}`));
  }

  private async handleCallees(args: Record<string, unknown>): Promise<McpToolResult> {
    const symbol = validateString(args.symbol, 'symbol');
    const db = await this.getDb();
    const adaptive = computeLimits(db, 'callees', {
      symbolName: symbol,
      explicitMaxNodes: args.limit != null ? clamp(Number(args.limit), 1, 100) : undefined,
    });
    const result = findCallees(db, symbol, { maxNodes: adaptive.maxNodes, maxDepth: adaptive.maxDepth });
    const callees = result.nodes.filter(n => n.name !== symbol);
    if (callees.length === 0) return this.textResult(`No callees found for "${symbol}"`);
    return this.textResult(this.formatNodeList(callees, `Callees of ${symbol}`));
  }

  private async handleImpact(args: Record<string, unknown>): Promise<McpToolResult> {
    const symbol = validateString(args.symbol, 'symbol');
    const db = await this.getDb();
    const adaptive = computeLimits(db, 'impact', {
      symbolName: symbol,
      explicitDepth: args.depth != null ? clamp(Number(args.depth), 1, 10) : undefined,
    });
    const result = analyzeImpact(db, symbol, { maxDepth: adaptive.maxDepth, maxNodes: adaptive.maxNodes });
    if (result.impacted_nodes.length === 0) return this.textResult(`No impact found for "${symbol}"`);
    const lines = [
      `## Impact Analysis: ${symbol}`, '',
      `**Impacted files (${result.impacted_files.length}):** ${result.impacted_files.join(', ')}`, '',
      `**Impacted symbols (${result.impacted_nodes.length}):**`,
    ];
    for (const n of result.impacted_nodes.slice(0, 30)) {
      lines.push(`- ${n.name} (${n.kind}) — ${n.file_path}:${n.start_line}`);
    }
    if (result.truncated) lines.push('', '... (truncated)');
    return this.textResult(lines.join('\n'));
  }

  private async handleFiles(args: Record<string, unknown>): Promise<McpToolResult> {
    const db = await this.getDb();
    const files = getIndexedFiles(db, {
      path: args.path as string | undefined,
      pattern: args.pattern as string | undefined,
    });
    if (files.length === 0) return this.textResult('No indexed files found.');

    const format = (args.format as string) || 'flat';
    if (format === 'grouped') {
      const byLang = new Map<string, typeof files>();
      for (const f of files) {
        const arr = byLang.get(f.language) ?? [];
        arr.push(f);
        byLang.set(f.language, arr);
      }
      const lines = [`## Files by Language (${files.length} total)`, ''];
      for (const [lang, lf] of [...byLang.entries()].sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`### ${lang} (${lf.length})`);
        for (const f of lf.sort((a, b) => a.path.localeCompare(b.path))) {
          lines.push(`- ${f.path} (${f.symbol_count} symbols)`);
        }
        lines.push('');
      }
      return this.textResult(lines.join('\n'));
    }

    // flat
    const lines = [`## Files (${files.length})`, ''];
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      lines.push(`- ${f.path} (${f.language}, ${f.symbol_count} symbols)`);
    }
    return this.textResult(lines.join('\n'));
  }

  private async handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
    const db = await this.getDb();
    const s = db.getStatus(this.rootDir);
    const lines = [
      '## cgraph Status', '',
      `**Files indexed:** ${s.files_count}`,
      `**Total nodes:** ${s.nodes_count}`,
      `**Total edges:** ${s.edges_count}`,
      `**Last indexed:** ${s.last_indexed ?? 'never'}`,
    ];
    if (Object.keys(s.languages).length > 0) {
      lines.push('', '### Languages');
      for (const [l, c] of Object.entries(s.languages)) lines.push(`- ${l}: ${c}`);
    }
    if (Object.keys(s.roles).length > 0) {
      lines.push('', '### Roles');
      for (const [r, c] of Object.entries(s.roles)) lines.push(`- ${r}: ${c}`);
    }
    return this.textResult(lines.join('\n'));
  }

  private async handleAffected(args: Record<string, unknown>): Promise<McpToolResult> {
    const filesStr = validateString(args.files, 'files');
    const db = await this.getDb();
    const changedFiles = filesStr.split(',').map(f => f.trim()).filter(f => f.length > 0);
    const adaptive = computeLimits(db, 'affected', {
      explicitDepth: args.depth != null ? clamp(Number(args.depth), 1, 20) : undefined,
    });
    const depth = adaptive.maxDepth;
    const result = findAffected(db, changedFiles, {
      depth,
      testPattern: args.filter as string | undefined,
    });
    if (result.affected_tests.length === 0) {
      return this.textResult('No test files affected by the given changes.');
    }
    const lines = [
      `## Affected Tests (${result.total_affected})`, '',
      `Changed: ${result.changed_files.join(', ')}`, '',
    ];
    for (const t of result.affected_tests) lines.push(`- ${t}`);
    return this.textResult(lines.join('\n'));
  }

  private async handleExport(args: Record<string, unknown>): Promise<McpToolResult> {
    const db = await this.getDb();
    const format = (args.format as string) || 'mermaid';
    const exportOpts = {
      symbol: args.symbol as string | undefined,
      maxDepth: args.depth != null ? clamp(Number(args.depth), 1, 10) : undefined,
      maxNodes: args.maxNodes != null ? clamp(Number(args.maxNodes), 1, 500) : undefined,
      direction: args.direction as 'forward' | 'backward' | 'both' | undefined,
    };
    const output = format === 'dot' ? toDot(db, exportOpts)
      : format === 'html' ? toHtml(db, exportOpts)
      : toMermaid(db, exportOpts);
    return this.textResult(output);
  }

  private async handleChanged(args: Record<string, unknown>): Promise<McpToolResult> {
    const db = await this.getDb();
    const symbols = findChangedSymbols(db, this.rootDir, {
      ref: (args.ref as string) || 'HEAD',
      staged: args.staged === true,
    });
    if (symbols.length === 0) {
      return this.textResult('No changed symbols detected in git diff.');
    }
    const lines = [`## Changed Symbols (${symbols.length})`, ''];
    for (const s of symbols) {
      const tag = s.change_type === 'in_diff' ? '**changed**' : 'in changed file';
      lines.push(`- ${s.name} (${s.kind}) — ${s.file}:${s.start_line} [${tag}]`);
    }
    lines.push('', '> Use cgraph_impact on these symbols to see what might break.');
    return this.textResult(lines.join('\n'));
  }

  private formatNodeList(nodes: { name: string; qualified_name: string; kind: string; file_path: string; start_line: number }[], title: string): string {
    const lines = [`## ${title} (${nodes.length})`, ''];
    for (const n of nodes) {
      lines.push(`- ${n.name} (${n.kind}) — ${n.file_path}:${n.start_line}`);
    }
    return lines.join('\n');
  }

  private textResult(text: string): McpToolResult {
    return { content: [{ type: 'text', text }] };
  }

  private errorResult(message: string): McpToolResult {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }

  close(): void {
    if (this.watcher) { this.watcher.stop(); this.watcher = null; }
    this.cache.saveToDisk();
    if (this.db) { this.db.close(); this.db = null; }
  }
}

// ─── JSON-RPC MCP server over stdio ────────────────────────────
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export function startMcpServer(rootDir: string): void {
  const handler = new ToolHandler(rootDir);
  let pending = 0;
  let stdinClosed = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  function send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
  }

  function maybeExit(): void {
    if (stdinClosed && pending === 0) {
      handler.close();
      process.exit(0);
    }
  }

  rl.on('line', (line: string) => {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const id = req.id;

    const handle = async () => {
      try {
        switch (req.method) {
          case 'initialize': {
            send({
              jsonrpc: '2.0', id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'cgraph', version: '0.1.0' },
              },
            });
            break;
          }

          case 'notifications/initialized': {
            // No response needed for notifications
            break;
          }

          case 'tools/list': {
            send({
              jsonrpc: '2.0', id,
              result: { tools: TOOLS },
            });
            break;
          }

          case 'tools/call': {
            const toolName = req.params?.name;
            const toolArgs = req.params?.arguments ?? {};
            const result = await handler.execute(toolName, toolArgs);
            send({ jsonrpc: '2.0', id, result });
            break;
          }

          case 'ping': {
            send({ jsonrpc: '2.0', id, result: {} });
            break;
          }

          default: {
            send({
              jsonrpc: '2.0', id,
              error: { code: -32601, message: `Method not found: ${req.method}` },
            });
          }
        }
      } catch (err: any) {
        send({
          jsonrpc: '2.0', id,
          error: { code: -32603, message: err.message ?? String(err) },
        });
      }
    };

    pending++;
    handle().finally(() => {
      pending--;
      maybeExit();
    });
  });

  rl.on('close', () => {
    stdinClosed = true;
    maybeExit();
  });

  process.on('SIGINT', () => {
    handler.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    handler.close();
    process.exit(0);
  });
}
