/**
 * Agent Workflow Benchmark — simulates a real GitHub Copilot session
 * answering developer questions WITH and WITHOUT cgraph.
 *
 * Each scenario replays the exact tool-call sequence an agent would make:
 *   WITHOUT: grep_search → read_file → grep_search → read_file → …
 *   WITH:    single cgraph MCP tool call
 *
 * Realistic overhead:
 *   Each agent tool-call round-trip ≈ 2 seconds (LLM thinking + API latency).
 *   Bytes returned = tokens consumed from the context window.
 *
 * Usage:  node scripts/benchmark-agent.mjs [project-dir]
 */
import { execSync } from 'child_process';
import { resolve, dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync } from 'fs';
import { performance } from 'perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const CGRAPH    = resolve(ROOT, 'bin', 'cgraph.js');
const TARGET    = resolve(process.argv[2] || ROOT);

const AGENT_ROUNDTRIP_MS = 2000; // avg LLM round-trip per tool call

// ─── helpers ───────────────────────────────────────────────────────
function walkFiles(dir, exts = ['.ts','.js','.py','.tsx','.jsx'], out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (['node_modules','.git','.cgraph','dist','__tests__'].includes(e.name)) continue;
    if (e.isDirectory()) walkFiles(p, exts, out);
    else if (exts.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
function rel(f) { return relative(TARGET, f).replace(/\\/g, '/'); }
function fmt(ms)  { return `${Math.round(ms)}ms`.padStart(7); }
function fmtSec(ms) { return `${(ms/1000).toFixed(1)}s`.padStart(6); }
function fmtKB(b) { return b > 1048576 ? `${(b/1048576).toFixed(1)}MB` : `${(b/1024).toFixed(1)}KB`; }

function cgraph(cmd, args = []) {
  const t0 = performance.now();
  const out = execSync(
    `node "${CGRAPH}" ${cmd} ${args.map(a => `"${a}"`).join(' ')}`,
    { cwd: TARGET, encoding: 'utf-8', timeout: 15000, stdio: ['pipe','pipe','pipe'] }
  );
  return { elapsed: performance.now() - t0, bytes: out.length, output: out };
}

// Step logger for "agent thought process" replay
class AgentReplay {
  constructor(question) {
    this.question  = question;
    this.steps     = [];
    this.totalMs   = 0;
    this.totalBytes = 0;
  }
  step(tool, detail, ms, bytes) {
    this.steps.push({ tool, detail, ms, bytes });
    this.totalMs   += ms;
    this.totalBytes += bytes;
  }
  print(label) {
    console.log(`  ${label}:`);
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      const bar = '█'.repeat(Math.max(1, Math.round(s.bytes / 1024)));
      console.log(`    ${String(i+1).padStart(2)}. ${s.tool.padEnd(16)} ${fmt(s.ms)}  ${fmtKB(s.bytes).padStart(8)}  ${s.detail}`);
    }
    const agentTime = this.steps.length * AGENT_ROUNDTRIP_MS + this.totalMs;
    console.log(`    ── total: ${this.steps.length} tool calls, ${fmt(this.totalMs)} compute, ${fmtSec(agentTime)} agent time, ${fmtKB(this.totalBytes)} context`);
    return { toolCalls: this.steps.length, computeMs: this.totalMs, agentMs: agentTime, bytes: this.totalBytes };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Scenario definitions — each one is a real developer question
// ═══════════════════════════════════════════════════════════════════

const scenarios = [];

// ── Scenario 1: "Where is parseFile defined and who calls it?" ────
scenarios.push({
  question: 'Where is parseFile defined and who calls it?',
  without(files) {
    const r = new AgentReplay(this.question);

    // Step 1: Agent greps for the definition
    const t0 = performance.now();
    let defFile = null, defLine = 0, defBytes = 0;
    for (const f of files) {
      const c = readFileSync(f, 'utf-8');
      const m = c.match(/(?:export\s+)?(?:function|async\s+function)\s+parseFile\b/);
      if (m) { defFile = f; defLine = c.slice(0, m.index).split('\n').length; defBytes = c.length; break; }
    }
    r.step('grep_search', `"function parseFile" → found ${rel(defFile)}`, performance.now() - t0,
           files.reduce((s,f) => s + f.length, 0) < 100 ? 512 : 512); // grep returns ~0.5KB snippet

    // Step 2: Agent reads the definition file
    const t1 = performance.now();
    const content = readFileSync(defFile, 'utf-8');
    r.step('read_file', `${rel(defFile)} (lines ${defLine}-${defLine+40})`, performance.now() - t1, Math.min(content.length, 3000));

    // Step 3: Agent greps for usages
    const t2 = performance.now();
    const callerFiles = [];
    for (const f of files) {
      const c = readFileSync(f, 'utf-8');
      if (c.includes('parseFile(') && f !== defFile) callerFiles.push(f);
    }
    r.step('grep_search', `"parseFile(" → ${callerFiles.length} files`, performance.now() - t2, 512 * callerFiles.length);

    // Step 4+: Agent reads each caller file for context
    for (const cf of callerFiles) {
      const t = performance.now();
      const c = readFileSync(cf, 'utf-8');
      const lines = c.split('\n');
      let snippet = '';
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('parseFile(')) {
          snippet = lines.slice(Math.max(0,i-3), i+4).join('\n');
          break;
        }
      }
      r.step('read_file', `${rel(cf)} (context around call)`, performance.now() - t, snippet.length || 2000);
    }

    return r;
  },
  withCgraph() {
    const r = new AgentReplay(this.question);
    // Single call: cgraph_callers parseFile
    const res = cgraph('callers', ['parseFile']);
    r.step('cgraph_callers', `"parseFile" → full caller tree`, res.elapsed, res.bytes);
    return r;
  }
});

// ── Scenario 2: "What's the impact of changing GraphDB.open?" ─────
scenarios.push({
  question: "What's the impact of changing GraphDB.open?",
  without(files) {
    const r = new AgentReplay(this.question);

    // Step 1: Find definition of 'open'
    const t0 = performance.now();
    let defFile = null;
    for (const f of files) {
      const c = readFileSync(f, 'utf-8');
      if (/(?:async\s+)?open\s*\(/.test(c) && c.includes('class GraphDB')) { defFile = f; break; }
    }
    r.step('grep_search', `"class GraphDB" + "open(" → ${rel(defFile)}`, performance.now() - t0, 600);

    // Step 2: Read the class to understand the method
    const t1 = performance.now();
    const content = readFileSync(defFile, 'utf-8');
    r.step('read_file', `${rel(defFile)} (full class, 300+ lines)`, performance.now() - t1, content.length);

    // Step 3: Find direct callers of .open(
    const t2 = performance.now();
    const callers = [];
    for (const f of files) {
      const c = readFileSync(f, 'utf-8');
      if (c.includes('.open(') && f !== defFile) callers.push(f);
    }
    r.step('grep_search', `".open(" → ${callers.length} files`, performance.now() - t2, 512);

    // Step 4: Read each caller file
    for (const cf of callers) {
      const t = performance.now();
      const c = readFileSync(cf, 'utf-8');
      r.step('read_file', `${rel(cf)}`, performance.now() - t, Math.min(c.length, 4000));
    }

    // Step 5: For each caller function, find THEIR callers (transitive impact)
    const t3 = performance.now();
    const secondOrder = new Set();
    for (const cf of callers) {
      const c = readFileSync(cf, 'utf-8');
      // Extract function names from the file
      const funcNames = [...c.matchAll(/(?:export\s+)?(?:function|async\s+function)\s+(\w+)/g)].map(m => m[1]);
      for (const fn of funcNames) {
        for (const f of files) {
          const fc = readFileSync(f, 'utf-8');
          if (fc.includes(fn + '(')) secondOrder.add(rel(f));
        }
      }
    }
    r.step('grep_search', `transitive callers (depth 2) → ${secondOrder.size} files`, performance.now() - t3, 512 * secondOrder.size);

    // Step 6: Agent tries to summarize — reads key files again
    for (const sf of [...secondOrder].slice(0, 3)) {
      const t = performance.now();
      const c = readFileSync(resolve(TARGET, sf), 'utf-8');
      r.step('read_file', `${sf} (verify impact)`, performance.now() - t, Math.min(c.length, 3000));
    }

    return r;
  },
  withCgraph() {
    const r = new AgentReplay(this.question);
    const res = cgraph('impact', ['open']);
    r.step('cgraph_impact', `"open" → full impact tree`, res.elapsed, res.bytes);
    return r;
  }
});

// ── Scenario 3: "Show me the call chain from CLI to the database" ─
scenarios.push({
  question: 'How does the CLI command reach the database layer?',
  without(files) {
    const r = new AgentReplay(this.question);

    // Step 1: Find CLI entry point
    const t0 = performance.now();
    let cliFile = null;
    for (const f of files) {
      if (f.includes('cli')) { cliFile = f; break; }
    }
    r.step('file_search', `"*cli*" → ${rel(cliFile)}`, performance.now() - t0, 256);

    // Step 2: Read CLI file
    const t1 = performance.now();
    const cliContent = readFileSync(cliFile, 'utf-8');
    r.step('read_file', `${rel(cliFile)} (full file)`, performance.now() - t1, cliContent.length);

    // Step 3: Find what CLI calls → identify indexProject, search, etc.
    const t2 = performance.now();
    const imports = [...cliContent.matchAll(/import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g)];
    const importedFns = imports.flatMap(m => m[1].split(',').map(s => s.trim()));
    r.step('semantic_search', `CLI imports: ${importedFns.slice(0,5).join(', ')}…`, performance.now() - t2, 512);

    // Step 4-6: Read each imported module to trace the chain
    for (const imp of imports.slice(0, 3)) {
      const modName = imp[2].replace('./', '').replace('.js', '');
      const modFile = files.find(f => f.includes(modName));
      if (modFile) {
        const t = performance.now();
        const c = readFileSync(modFile, 'utf-8');
        r.step('read_file', `${rel(modFile)} (trace chain)`, performance.now() - t, c.length);
      }
    }

    // Step 7: Find storage/db layer
    const t3 = performance.now();
    let storageFile = files.find(f => f.includes('storage'));
    if (storageFile) {
      const c = readFileSync(storageFile, 'utf-8');
      r.step('read_file', `${rel(storageFile)} (DB layer)`, performance.now() - t3, c.length);
    }

    // Step 8: Agent needs to grep for the connecting calls
    const t4 = performance.now();
    for (const f of files) {
      const c = readFileSync(f, 'utf-8');
      if (c.includes('GraphDB') || c.includes('.open(') || c.includes('.save(')) {
        // just scanning
      }
    }
    r.step('grep_search', `"GraphDB|.open|.save" across all files`, performance.now() - t4, 1024);

    return r;
  },
  withCgraph() {
    const r = new AgentReplay(this.question);

    // Agent knows CLI entry point function, traces to DB
    const res1 = cgraph('trace', ['runCli', 'open']);
    r.step('cgraph_trace', `"runCli" → "open" path`, res1.elapsed, res1.bytes);

    return r;
  }
});

// ── Scenario 4: "I changed utils.ts — what tests should I run?" ───
scenarios.push({
  question: 'I changed src/config.ts — what tests should I run?',
  without(files) {
    const r = new AgentReplay(this.question);

    // Step 1: Read the changed file
    const t0 = performance.now();
    const cfgFile = files.find(f => f.includes('config.'));
    const cfgContent = cfgFile ? readFileSync(cfgFile, 'utf-8') : '';
    r.step('read_file', `${rel(cfgFile)} (understand changes)`, performance.now() - t0, cfgContent.length);

    // Step 2: Extract exported symbols
    const t1 = performance.now();
    const exports = [...cfgContent.matchAll(/export\s+(?:function|const|class|interface|type)\s+(\w+)/g)].map(m => m[1]);
    r.step('grep_search', `exported symbols: ${exports.slice(0,5).join(', ')}`, performance.now() - t1, 512);

    // Step 3: For each export, grep who imports it
    const allFiles = walkFiles(TARGET, ['.ts','.js','.py','.tsx','.jsx','.test.ts']);
    const testFiles = [];
    for (const exp of exports) {
      const t = performance.now();
      for (const f of allFiles) {
        try {
          const c = readFileSync(f, 'utf-8');
          if (c.includes(exp) && f.includes('test')) testFiles.push(f);
        } catch {}
      }
    }
    const t2 = performance.now();
    r.step('grep_search', `find test files importing ${exports.length} symbols`, t2 - t1, 512 * exports.length);

    // Step 4: Find indirect dependents — files that import config
    const t3 = performance.now();
    const dependents = [];
    for (const f of allFiles) {
      try {
        const c = readFileSync(f, 'utf-8');
        if (c.includes("from './config") || c.includes("from '../config") || c.includes('from "./config')) {
          dependents.push(f);
        }
      } catch {}
    }
    r.step('grep_search', `"from './config" → ${dependents.length} dependents`, performance.now() - t3, 512);

    // Step 5: For each dependent, find its test files
    const t4 = performance.now();
    const indirectTests = new Set();
    for (const dep of dependents) {
      const baseName = rel(dep).replace(/\.ts$/, '').replace('src/', '');
      for (const f of allFiles) {
        if (f.includes('test') && f.includes(baseName)) indirectTests.add(rel(f));
      }
    }
    r.step('grep_search', `find tests for ${dependents.length} dependents`, performance.now() - t4, 512);

    // Step 6: Read a test file to verify
    if (testFiles.length > 0) {
      const t = performance.now();
      const c = readFileSync(testFiles[0], 'utf-8');
      r.step('read_file', `${rel(testFiles[0])} (verify relevance)`, performance.now() - t, Math.min(c.length, 3000));
    }

    return r;
  },
  withCgraph() {
    const r = new AgentReplay(this.question);
    const cfgRel = 'src/config.ts';
    const res = cgraph('affected', [cfgRel]);
    r.step('cgraph_affected', `"${cfgRel}" → affected files + test mapping`, res.elapsed, res.bytes);
    return r;
  }
});

// ── Scenario 5: "Explain the architecture — what are the main modules?" ──
scenarios.push({
  question: 'Explain the architecture and how modules connect.',
  without(files) {
    const r = new AgentReplay(this.question);

    // Step 1: List project structure
    const t0 = performance.now();
    r.step('list_dir', `src/ → ${files.length} source files`, performance.now() - t0, files.map(rel).join('\n').length);

    // Step 2-6: Read each major source file to understand structure
    const majorFiles = files.filter(f =>
      ['index.', 'cli.', 'mcp.', 'parser.', 'graph.', 'storage.', 'indexer.', 'search.', 'config.', 'context.'].some(k => f.includes(k))
    ).slice(0, 5);

    for (const f of majorFiles) {
      const t = performance.now();
      const c = readFileSync(f, 'utf-8');
      r.step('read_file', `${rel(f)} (understand module)`, performance.now() - t, c.length);
    }

    // Step 7: Agent reads remaining files
    const remaining = files.filter(f => !majorFiles.includes(f)).slice(0, 4);
    for (const f of remaining) {
      const t = performance.now();
      const c = readFileSync(f, 'utf-8');
      r.step('read_file', `${rel(f)} (complete picture)`, performance.now() - t, c.length);
    }

    // Step 8: Agent greps for cross-module imports
    const t1 = performance.now();
    let importBytes = 0;
    for (const f of files) {
      const c = readFileSync(f, 'utf-8');
      const imps = [...c.matchAll(/import\s+.*from\s+['"]\.\/[^'"]+['"]/g)];
      importBytes += imps.join('\n').length;
    }
    r.step('grep_search', `cross-module imports → dependency map`, performance.now() - t1, importBytes || 2048);

    return r;
  },
  withCgraph() {
    const r = new AgentReplay(this.question);

    // Single call: explore for high-level overview
    const res1 = cgraph('explore', ['src']);
    r.step('cgraph_explore', `"src" → module overview`, res1.elapsed, res1.bytes);

    // Optionally get file-level detail
    const res2 = cgraph('files', []);
    r.step('cgraph_files', `file stats + edge density`, res2.elapsed, res2.bytes);

    return r;
  }
});

// ═══════════════════════════════════════════════════════════════════
// Run all scenarios
// ═══════════════════════════════════════════════════════════════════

function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║   Agent Workflow Benchmark — GitHub Copilot WITH vs WITHOUT cgraph║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log(`  Target:     ${TARGET}`);

  const files = walkFiles(TARGET);
  console.log(`  Source files: ${files.length}`);
  console.log(`  Agent round-trip assumption: ${AGENT_ROUNDTRIP_MS}ms per tool call`);
  console.log('');

  // Ensure index exists
  try { execSync(`node "${CGRAPH}" index`, { cwd: TARGET, stdio: 'pipe' }); } catch {}

  const results = [];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    console.log(`┌──────────────────────────────────────────────────────────────────┐`);
    console.log(`│  Q${i+1}: "${s.question}"`.padEnd(67) + '│');
    console.log(`└──────────────────────────────────────────────────────────────────┘`);
    console.log('');

    const wo = s.without(files);
    const woStats = wo.print('WITHOUT cgraph (agent grep+read workflow)');
    console.log('');

    const wi = s.withCgraph();
    const wiStats = wi.print('WITH cgraph');
    console.log('');

    const speedup = woStats.agentMs / Math.max(wiStats.agentMs, 1);
    const tokenSavings = Math.round((1 - wiStats.bytes / Math.max(woStats.bytes, 1)) * 100);

    console.log(`  ⚡ Result:  ${woStats.toolCalls} tool calls → ${wiStats.toolCalls}  |  ` +
                `${fmtSec(woStats.agentMs)} → ${fmtSec(wiStats.agentMs)}  |  ` +
                `${fmtKB(woStats.bytes)} → ${fmtKB(wiStats.bytes)}  |  ` +
                `${speedup.toFixed(1)}x faster, ${tokenSavings}% fewer tokens`);
    console.log('');

    results.push({ question: s.question, wo: woStats, wi: wiStats, speedup, tokenSavings });
  }

  // ─── Final Summary ──────────────────────────────────────────
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║  FINAL SUMMARY                                                   ║');
  console.log('╠════════════════════════════════════════════════════════════════════╣');
  console.log('║  Question                           │ Calls │ Agent Time │ Tokens ║');
  console.log('╠─────────────────────────────────────┼───────┼────────────┼────────╣');

  let totWoCalls = 0, totWiCalls = 0;
  let totWoTime = 0, totWiTime = 0;
  let totWoBytes = 0, totWiBytes = 0;

  for (const r of results) {
    const q = r.question.slice(0, 35).padEnd(35);
    const calls = `${r.wo.toolCalls}→${r.wi.toolCalls}`.padStart(5);
    const time = `${fmtSec(r.wo.agentMs)}→${fmtSec(r.wi.agentMs)}`.padStart(10);
    const tokens = `${r.tokenSavings}%↓`.padStart(6);
    console.log(`║  ${q} │ ${calls} │ ${time} │ ${tokens} ║`);

    totWoCalls += r.wo.toolCalls;
    totWiCalls += r.wi.toolCalls;
    totWoTime  += r.wo.agentMs;
    totWiTime  += r.wi.agentMs;
    totWoBytes += r.wo.bytes;
    totWiBytes += r.wi.bytes;
  }

  console.log('╠═════════════════════════════════════╧═══════╧════════════╧════════╣');
  console.log(`║  Total tool calls:  ${totWoCalls} → ${totWiCalls}`.padEnd(67) + '║');
  console.log(`║  Total agent time:  ${fmtSec(totWoTime)} → ${fmtSec(totWiTime)}  (${(totWoTime / Math.max(totWiTime,1)).toFixed(1)}x faster)`.padEnd(67) + '║');
  console.log(`║  Total context:     ${fmtKB(totWoBytes)} → ${fmtKB(totWiBytes)}  (${Math.round((1 - totWiBytes / totWoBytes) * 100)}% less)`.padEnd(67) + '║');
  console.log(`║  Avg speedup:       ${(results.reduce((s,r) => s+r.speedup, 0) / results.length).toFixed(1)}x across ${results.length} questions`.padEnd(67) + '║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log('');
}

main();
