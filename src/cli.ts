#!/usr/bin/env node
/**
 * cgraph CLI — code graph tool for GHCP agent efficiency.
 *
 * All commands output JSON by default (agent-ready).
 * Use --pretty for human-readable formatting.
 */
import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { GraphDB } from './storage';
import { indexProject } from './indexer';
import { findCallers, findCallees, analyzeImpact, findSymbol, tracePath, getNodeDetail, getIndexedFiles, findAffected, findDeadCode, findCycles, getProjectStats, suggestRefactorings, getAutoContext, validatePlan, getCodebaseDNA } from './graph';
import { searchSymbols, intentSearch } from './search';
import { buildContext, explore } from './context';
import { getDbPath, DEFAULT_CONFIG, loadConfig } from './config';
import { lintArchitecture } from './lint';
import { computeLimits } from './adaptive';
import { toMermaid, toDot, toHtml } from './export';
import { findChangedSymbols, getChangedFiles } from './git';
import { startMcpServer } from './mcp';
import { FileWatcher } from './watcher';

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
);

const program = new Command();

program
  .name('cgraph')
  .description('Code graph CLI for GHCP agent efficiency')
  .version(pkg.version);

// ── helpers ──────────────────────────────────────────────────────
function out(data: unknown, pretty?: boolean): void {
  const json = pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  process.stdout.write(json + '\n');
}

function resolveRoot(dir?: string): string {
  return path.resolve(dir ?? process.cwd());
}

async function openDb(rootDir: string): Promise<GraphDB> {
  const dbPath = getDbPath(rootDir);
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({
      error: 'No graph database found. Run "cgraph index" first.',
      db_path: dbPath,
    }));
    process.exit(1);
  }
  return GraphDB.open(dbPath);
}

// ── cgraph index ────────────────────────────────────────────────
program
  .command('index')
  .alias('build')
  .description('Index or re-index the codebase')
  .argument('[dir]', 'project root directory', '.')
  .option('--force', 'force full re-index (ignore cache)')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (dir: string, opts: { force?: boolean; pretty?: boolean }) => {
    const root = resolveRoot(dir);
    try {
      const result = await indexProject(root, { force: opts.force });
      out(result, opts.pretty);
    } catch (err: any) {
      out({ error: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ── cgraph sync ─────────────────────────────────────────────────
program
  .command('sync')
  .description('Incremental sync — index only changed files')
  .argument('[dir]', 'project root directory', '.')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (dir: string, opts: { pretty?: boolean }) => {
    const root = resolveRoot(dir);
    try {
      const result = await indexProject(root, { force: false });
      out(result, opts.pretty);
    } catch (err: any) {
      out({ error: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ── cgraph status ───────────────────────────────────────────────
program
  .command('status')
  .description('Show index status and statistics')
  .argument('[dir]', 'project root directory', '.')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (dir: string, opts: { pretty?: boolean }) => {
    const root = resolveRoot(dir);
    const dbPath = getDbPath(root);
    if (!fs.existsSync(dbPath)) {
      out({
        db_path: dbPath,
        exists: false,
        files_count: 0,
        nodes_count: 0,
        edges_count: 0,
        last_indexed: null,
        languages: {},
        roles: {},
      }, opts.pretty);
      return;
    }
    const db = await GraphDB.open(dbPath);
    try {
      out(db.getStatus(root), opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph search ───────────────────────────────────────────────
program
  .command('search')
  .description('Search for symbols by name or text')
  .argument('<query>', 'search query')
  .option('-n, --limit <n>', 'max results', '20')
  .option('-k, --kind <kind>', 'filter by kind (function, class, method, ...)')
  .option('-f, --file <path>', 'scope to a specific file')
  .option('--pretty', 'pretty-print JSON output')
  .option('[dir]') // silently accept dir
  .action(async (query: string, opts: any) => {
    const root = resolveRoot(opts.dir);
    const db = await openDb(root);
    try {
      const results = searchSymbols(db, query, {
        limit: parseInt(opts.limit, 10),
        kind: opts.kind,
        file: opts.file,
      });
      out({
        query,
        results: results.map(r => ({
          name: r.node.name,
          qualified_name: r.node.qualified_name,
          kind: r.node.kind,
          role: r.node.role,
          file: r.file_path,
          line: r.node.start_line,
          signature: r.node.signature,
          rank: r.rank,
        })),
        total: results.length,
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph callers ──────────────────────────────────────────────
program
  .command('callers')
  .description('Find all callers of a symbol')
  .argument('<symbol>', 'symbol name')
  .option('--depth <n>', 'max traversal depth')
  .option('--limit <n>', 'max nodes')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (symbol: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const adaptive = computeLimits(db, 'callers', {
        symbolName: symbol,
        explicitDepth: opts.depth ? parseInt(opts.depth, 10) : undefined,
        explicitMaxNodes: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      const result = findCallers(db, symbol, {
        maxDepth: adaptive.maxDepth,
        maxNodes: adaptive.maxNodes,
      });
      out({
        symbol,
        callers: result.nodes.map(n => ({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          role: n.role,
          file: n.file_path,
          line: n.start_line,
          depth: n.depth,
        })),
        edges: result.edges.length,
        truncated: result.truncated,
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph callees ──────────────────────────────────────────────
program
  .command('callees')
  .description('Find all callees of a symbol')
  .argument('<symbol>', 'symbol name')
  .option('--depth <n>', 'max traversal depth')
  .option('--limit <n>', 'max nodes')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (symbol: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const adaptive = computeLimits(db, 'callees', {
        symbolName: symbol,
        explicitDepth: opts.depth ? parseInt(opts.depth, 10) : undefined,
        explicitMaxNodes: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      const result = findCallees(db, symbol, {
        maxDepth: adaptive.maxDepth,
        maxNodes: adaptive.maxNodes,
      });
      out({
        symbol,
        callees: result.nodes.map(n => ({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          role: n.role,
          file: n.file_path,
          line: n.start_line,
          depth: n.depth,
        })),
        edges: result.edges.length,
        truncated: result.truncated,
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph impact ───────────────────────────────────────────────
program
  .command('impact')
  .description('Analyze impact of changing a file or symbol')
  .argument('<target>', 'symbol name or file path')
  .option('--depth <n>', 'max traversal depth')
  .option('--limit <n>', 'max nodes')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (target: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const adaptive = computeLimits(db, 'impact', {
        symbolName: target,
        explicitDepth: opts.depth ? parseInt(opts.depth, 10) : undefined,
        explicitMaxNodes: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      const result = analyzeImpact(db, target, {
        maxDepth: adaptive.maxDepth,
        maxNodes: adaptive.maxNodes,
      });
      out({
        target: result.target,
        impacted_nodes: result.impacted_nodes.map(n => ({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          file: n.file_path,
          line: n.start_line,
          depth: n.depth,
        })),
        impacted_files: result.impacted_files,
        total_impacted: result.impacted_nodes.length,
        truncated: result.truncated,
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph context ──────────────────────────────────────────────
program
  .command('context')
  .description('Build minimal context payload for a task')
  .argument('<task>', 'task description (natural language)')
  .option('--depth <n>', 'max expansion depth')
  .option('--limit <n>', 'max nodes')
  .option('--snippets <n>', 'max snippets', '20')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (task: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const adaptive = computeLimits(db, 'context', {
        explicitDepth: opts.depth ? parseInt(opts.depth, 10) : undefined,
        explicitMaxNodes: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      const payload = buildContext(db, root, task, {
        maxDepth: adaptive.maxDepth,
        maxNodes: adaptive.maxNodes,
        maxSnippets: parseInt(opts.snippets, 10),
      });
      out(payload, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph query (like optave's query — find + callers/callees) ─
program
  .command('query')
  .description('Find a symbol and show its callers + callees')
  .argument('<name>', 'symbol name')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (name: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const matches = findSymbol(db, name);
      if (matches.length === 0) {
        out({ symbol: name, found: false, matches: [] }, opts.pretty);
        return;
      }

      const primary = matches[0];
      const callerResult = findCallers(db, name, { maxDepth: 1, maxNodes: 20 });
      const calleeResult = findCallees(db, name, { maxDepth: 1, maxNodes: 20 });

      out({
        symbol: name,
        found: true,
        definition: {
          qualified_name: primary.qualified_name,
          kind: primary.kind,
          role: primary.role,
          file: primary.file_path,
          line: primary.start_line,
          end_line: primary.end_line,
          signature: primary.signature,
        },
        callers: callerResult.nodes
          .filter(n => n.id !== primary.id)
          .map(n => ({
            name: n.name,
            file: n.file_path,
            line: n.start_line,
            kind: n.kind,
          })),
        callees: calleeResult.nodes
          .filter(n => n.id !== primary.id)
          .map(n => ({
            name: n.name,
            file: n.file_path,
            line: n.start_line,
            kind: n.kind,
          })),
        other_matches: matches.length > 1
          ? matches.slice(1).map(m => ({
              qualified_name: m.qualified_name,
              file: m.file_path,
              line: m.start_line,
            }))
          : undefined,
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph where (fast symbol lookup) ───────────────────────────
program
  .command('where')
  .description('Find where a symbol is defined')
  .argument('<name>', 'symbol name')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (name: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const matches = findSymbol(db, name);
      out({
        symbol: name,
        locations: matches.map(m => ({
          qualified_name: m.qualified_name,
          kind: m.kind,
          role: m.role,
          file: m.file_path,
          line: m.start_line,
          end_line: m.end_line,
          exported: m.exported === 1,
          callers: m.callers,
          callees: m.callees,
        })),
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph trace ────────────────────────────────────────────────
program
  .command('trace')
  .description('Trace call path between two symbols')
  .argument('<from>', 'source symbol name')
  .argument('<to>', 'target symbol name')
  .option('--code', 'include source code for each hop')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (from: string, to: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = tracePath(db, root, from, to, {
        includeCode: opts.code === true,
      });
      out(result, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph explore ──────────────────────────────────────────────
program
  .command('explore')
  .description('Deep dive into related symbols with source code')
  .argument('<query>', 'symbol names or file names to explore')
  .option('--max-files <n>', 'max files to include source from', '12')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (query: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = explore(db, root, query, {
        maxFiles: parseInt(opts.maxFiles, 10),
      });
      out(result, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph node ─────────────────────────────────────────────────
program
  .command('node')
  .description('Get symbol details with callers/callees trail')
  .argument('<symbol>', 'symbol name')
  .option('--code', 'include source code')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (symbol: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const detail = getNodeDetail(db, root, symbol, {
        includeCode: opts.code === true,
      });
      if (!detail) {
        out({ error: `Symbol "${symbol}" not found` }, opts.pretty);
        process.exit(1);
      }
      out(detail, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph export ───────────────────────────────────────────────
program
  .command('export')
  .description('Export the code graph as Mermaid, DOT, or interactive HTML diagram')
  .option('--format <fmt>', 'output format (mermaid|dot|html)', 'mermaid')
  .option('--symbol <name>', 'center the diagram on this symbol')
  .option('--depth <n>', 'traversal depth from symbol', '4')
  .option('--limit <n>', 'max nodes to include', '100')
  .option('--direction <dir>', 'traversal direction (forward|backward|both)', 'both')
  .option('-o, --output <file>', 'write to file instead of stdout')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const exportOpts = {
        symbol: opts.symbol as string | undefined,
        maxDepth: parseInt(opts.depth, 10),
        maxNodes: parseInt(opts.limit, 10),
        direction: opts.direction as 'forward' | 'backward' | 'both',
      };
      const output = opts.format === 'dot' ? toDot(db, exportOpts)
        : opts.format === 'html' ? toHtml(db, exportOpts)
        : toMermaid(db, exportOpts);
      if (opts.output) {
        fs.writeFileSync(opts.output, output, 'utf-8');
        process.stdout.write(JSON.stringify({ file: opts.output, format: opts.format }) + '\n');
      } else {
        process.stdout.write(output + '\n');
      }
    } finally {
      db.close();
    }
  });

// ── cgraph changed ──────────────────────────────────────────────
program
  .command('changed')
  .description('Find symbols changed in git diff')
  .option('--ref <ref>', 'git ref to diff against', 'HEAD')
  .option('--staged', 'only show staged changes')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const symbols = findChangedSymbols(db, root, {
        ref: opts.ref,
        staged: opts.staged === true,
      });
      out({
        changed_symbols: symbols,
        total: symbols.length,
        changed_files: getChangedFiles(root, { ref: opts.ref, staged: opts.staged }),
      }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph files ────────────────────────────────────────────────
program
  .command('files')
  .description('List indexed files with metadata')
  .argument('[dir]', 'project root directory', '.')
  .option('--path <filter>', 'filter to files under this directory')
  .option('--pattern <glob>', 'glob pattern filter')
  .option('--format <fmt>', 'output format: flat, tree, grouped', 'flat')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (dir: string, opts: any) => {
    const root = resolveRoot(dir);
    const db = await openDb(root);
    try {
      const files = getIndexedFiles(db, {
        path: opts.path,
        pattern: opts.pattern,
      });
      out({ files, total: files.length }, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph affected ─────────────────────────────────────────────
program
  .command('affected')
  .description('Find test files affected by changed source files')
  .argument('[files...]', 'changed file paths')
  .option('--stdin', 'read file list from stdin')
  .option('--depth <n>', 'max dependency traversal depth')
  .option('--filter <glob>', 'custom glob to identify test files')
  .option('--pretty', 'pretty-print JSON output')
  .action(async (files: string[], opts: any) => {
    const root = resolveRoot();
    let changedFiles = files;

    if (opts.stdin) {
      const input = fs.readFileSync(0, 'utf-8');
      changedFiles = input.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    }

    if (changedFiles.length === 0) {
      out({ error: 'No files specified. Pass file paths or use --stdin.' }, opts.pretty);
      process.exit(1);
    }

    const db = await openDb(root);
    try {
      const result = findAffected(db, changedFiles, {
        depth: opts.depth ? parseInt(opts.depth, 10) : computeLimits(db, 'affected').maxDepth,
        testPattern: opts.filter,
      });
      out(result, opts.pretty);
    } finally {
      db.close();
    }
  });

// ── cgraph deadcode ─────────────────────────────────────────────
program
  .command('deadcode')
  .description('Find dead code — symbols with no callers and not exported')
  .option('--kind <kind>', 'filter by symbol kind (function, class, method, etc.)')
  .option('--file <path>', 'filter by file path substring')
  .option('--limit <n>', 'max results', '100')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = findDeadCode(db, {
        kind: opts.kind,
        file: opts.file,
        limit: parseInt(opts.limit, 10),
      });
      if (opts.json) {
        out(result);
      } else {
        out(result, true);
      }
    } finally {
      db.close();
    }
  });

// ── cgraph cycles ───────────────────────────────────────────────
program
  .command('cycles')
  .description('Detect circular dependencies in the code graph')
  .option('--max <n>', 'max cycles to report', '50')
  .option('--edges <type>', 'edge types: calls, imports, both', 'both')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const edgeKinds = opts.edges === 'both' ? ['calls', 'imports'] as any[]
        : [opts.edges] as any[];
      const result = findCycles(db, {
        maxCycles: parseInt(opts.max, 10),
        edgeKinds,
      });
      if (opts.json) {
        out(result);
      } else {
        out(result, true);
      }
    } finally {
      db.close();
    }
  });

// ── cgraph stats ────────────────────────────────────────────────
program
  .command('stats')
  .description('Get project-wide code metrics: hotspots, coupling, complexity')
  .option('--limit <n>', 'max items in lists', '15')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = getProjectStats(db, {
        limit: parseInt(opts.limit, 10),
      });
      if (opts.json) {
        out(result);
      } else {
        out(result, true);
      }
    } finally {
      db.close();
    }
  });

// ── cgraph suggest ──────────────────────────────────────────────
program
  .command('suggest')
  .description('Suggest refactorings: extract, inline, move, dead code, split')
  .option('--symbol <name>', 'scope to a specific symbol')
  .option('--file <path>', 'scope to a specific file')
  .option('--limit <n>', 'max suggestions', '30')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = suggestRefactorings(db, {
        symbol: opts.symbol,
        file: opts.file,
        limit: parseInt(opts.limit, 10),
      });
      if (opts.json) {
        out(result);
      } else {
        out(result, true);
      }
    } finally {
      db.close();
    }
  });

// ── cgraph auto-context ─────────────────────────────────────────
program
  .command('auto-context')
  .description('Warm-start file awareness: symbols, callers, callees, tests, imports')
  .argument('<file>', 'file path to analyze')
  .option('--json', 'output raw JSON')
  .action(async (file: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = getAutoContext(db, file);
      if (opts.json) { out(result); } else { out(result, true); }
    } finally { db.close(); }
  });

// ── cgraph intent ───────────────────────────────────────────────
program
  .command('intent')
  .description('Search symbols by natural language intent (BM25 ranking)')
  .argument('<query>', 'natural language description')
  .option('--kind <kind>', 'filter by symbol kind')
  .option('--limit <n>', 'max results', '20')
  .option('--json', 'output raw JSON')
  .action(async (query: string, opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = intentSearch(db, query, {
        kind: opts.kind,
        limit: parseInt(opts.limit, 10),
      });
      if (opts.json) { out(result); } else { out(result, true); }
    } finally { db.close(); }
  });

// ── cgraph validate ─────────────────────────────────────────────
program
  .command('validate')
  .description('Pre-flight change risk assessment: blast radius, tests, cycles')
  .option('--symbols <names>', 'comma-separated symbol names')
  .option('--files <paths>', 'comma-separated file paths')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const symbols = opts.symbols ? opts.symbols.split(',').map((s: string) => s.trim()) : undefined;
      const files = opts.files ? opts.files.split(',').map((s: string) => s.trim()) : undefined;
      const result = validatePlan(db, { symbols, files });
      if (opts.json) { out(result); } else { out(result, true); }
    } finally { db.close(); }
  });

// ── cgraph lint ─────────────────────────────────────────────────
program
  .command('lint')
  .description('Check architecture rules from .cgraph.json')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const config = loadConfig(root);
      const rules = config.rules ?? [];
      if (rules.length === 0) {
        console.error(JSON.stringify({ error: 'No rules defined in .cgraph.json' }));
        process.exit(1);
      }
      const result = lintArchitecture(db, rules);
      if (opts.json) { out(result); } else { out(result, true); }
      if (!result.passed) process.exit(1);
    } finally { db.close(); }
  });

// ── cgraph dna ──────────────────────────────────────────────────
program
  .command('dna')
  .description('Codebase fingerprint: languages, architecture, health scores, hubs')
  .option('--json', 'output raw JSON')
  .action(async (opts: any) => {
    const root = resolveRoot();
    const db = await openDb(root);
    try {
      const result = getCodebaseDNA(db);
      if (opts.json) { out(result); } else { out(result, true); }
    } finally { db.close(); }
  });

// ── cgraph serve --mcp ──────────────────────────────────────────
program
  .command('serve')
  .description('Start MCP server for AI agent integration')
  .option('--mcp', 'start as MCP server (stdio JSON-RPC)')
  .option('--path <dir>', 'project root directory')
  .action(async (opts: any) => {
    if (!opts.mcp) {
      console.error('Use --mcp flag to start MCP server. Example: cgraph serve --mcp');
      process.exit(1);
    }
    const root = resolveRoot(opts.path);
    startMcpServer(root);
  });

// ── cgraph watch ────────────────────────────────────────────────
program
  .command('watch')
  .description('Watch for file changes and auto-sync the graph')
  .argument('[dir]', 'project root directory', '.')
  .option('--debounce <ms>', 'debounce interval in ms', '2000')
  .action(async (dir: string, opts: any) => {
    const root = resolveRoot(dir);

    // Ensure index exists
    const dbPath = getDbPath(root);
    if (!fs.existsSync(dbPath)) {
      console.error(JSON.stringify({ status: 'indexing', message: 'No index found, building initial index...' }));
      await indexProject(root);
    }

    const watcher = new FileWatcher(root, {
      debounceMs: parseInt(opts.debounce, 10),
      onSync: (result) => {
        console.log(JSON.stringify({
          status: 'synced',
          files_changed: result.files_changed,
          duration_ms: result.duration_ms,
          timestamp: new Date().toISOString(),
        }));
      },
      onError: (err) => {
        console.error(JSON.stringify({ status: 'error', message: err.message }));
      },
    });

    console.log(JSON.stringify({ status: 'watching', directory: root }));
    watcher.start();

    // Keep alive
    process.on('SIGINT', () => { watcher.stop(); process.exit(0); });
    process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
  });

// ── parse errors ────────────────────────────────────────────────
program.on('command:*', () => {
  console.error(JSON.stringify({
    error: `Unknown command: ${program.args.join(' ')}`,
    hint: 'Run "cgraph --help" for usage.',
  }));
  process.exit(1);
});

program.parse();
