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

// ═══════════════════════════════════════════════════════════════════
// Auto-detect symbols from target project for portable scenarios
// ═══════════════════════════════════════════════════════════════════

function detectSymbols(files) {
  const classes = [], functions = [], methods = [];
  const funcRe = /(?:export\s+)?(?:function|async\s+function)\s+(\w+)/g;
  const classRe = /(?:export\s+)?class\s+(\w+)/g;
  const methodRe = /^\s+(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/gm;

  for (const f of files) {
    const c = readFileSync(f, 'utf-8');
    for (const m of c.matchAll(funcRe)) functions.push({ name: m[1], file: f });
    for (const m of c.matchAll(classRe)) classes.push({ name: m[1], file: f });
    for (const m of c.matchAll(methodRe)) {
      if (!['if','for','while','switch','catch','constructor'].includes(m[1]))
        methods.push({ name: m[1], file: f });
    }
  }
  // Pick symbols with most callers/usage for interesting benchmarks
  const freq = {};
  for (const f of files) {
    const c = readFileSync(f, 'utf-8');
    for (const fn of [...functions, ...methods]) {
      if (c.includes(fn.name + '(')) freq[fn.name] = (freq[fn.name] || 0) + 1;
    }
  }
  const sorted = Object.entries(freq).sort((a,b) => b[1] - a[1]);
  const topFn = sorted.find(([n]) => functions.some(f => f.name === n));
  const topMethod = sorted.find(([n]) => methods.some(m => m.name === n) && !functions.some(f => f.name === n));

  // Find an entry point (main, app, index, handle)
  const entry = functions.find(f => ['main','handle','app','run','start','createApp','startGame'].includes(f.name))
    || functions[0];

  // Find a utility function (deeply called)
  const utilFn = topFn ? functions.find(f => f.name === topFn[0]) || functions[0] : functions[0];

  // Find a class
  const mainClass = classes.length > 0 ? classes[0] : null;

  // Find a file that lots of things depend on (types, utils, models)
  const utilFile = files.find(f => /\b(types|utils|validation|helpers|common|models)\b/.test(f)) || files[0];

  // Find a leaf utility function (small, many callers)
  const leafUtil = sorted.length > 2
    ? functions.find(f => f.name === sorted[Math.min(2, sorted.length - 1)][0]) || utilFn
    : utilFn;

  return { entry, utilFn, leafUtil, mainClass, utilFile, classes, functions, methods };
}

const scenarios = [];

function buildScenarios(files) {
  const sym = detectSymbols(files);

  const entryName = sym.entry?.name || 'main';
  const utilName = sym.utilFn?.name || 'helper';
  const leafName = sym.leafUtil?.name || utilName;
  const className = sym.mainClass?.name || 'Service';
  const utilFileRel = rel(sym.utilFile);

  // ── Scenario 1: "Where is X defined and who calls it?" ────
  scenarios.push({
    question: `Where is ${leafName} defined and who calls it?`,
    without(files) {
      const r = new AgentReplay(this.question);
      const searchName = leafName;

      // Step 1: Agent greps for the definition
      const t0 = performance.now();
      let defFile = null;
      for (const f of files) {
        const c = readFileSync(f, 'utf-8');
        const re = new RegExp(`(?:export\\s+)?(?:function|async\\s+function)\\s+${searchName}\\b`);
        if (re.test(c)) { defFile = f; break; }
      }
      if (!defFile) defFile = files[0];
      r.step('grep_search', `"function ${searchName}" → found ${rel(defFile)}`, performance.now() - t0, 512);

      // Step 2: Agent reads the definition file
      const t1 = performance.now();
      const content = readFileSync(defFile, 'utf-8');
      r.step('read_file', `${rel(defFile)} (read definition)`, performance.now() - t1, Math.min(content.length, 3000));

      // Step 3: Agent greps for usages
      const t2 = performance.now();
      const callerFiles = [];
      for (const f of files) {
        const c = readFileSync(f, 'utf-8');
        if (c.includes(searchName + '(') && f !== defFile) callerFiles.push(f);
      }
      r.step('grep_search', `"${searchName}(" → ${callerFiles.length} files`, performance.now() - t2, 512 * callerFiles.length);

      // Step 4+: Agent reads each caller file for context
      for (const cf of callerFiles) {
        const t = performance.now();
        const c = readFileSync(cf, 'utf-8');
        const lines = c.split('\n');
        let snippet = '';
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(searchName + '(')) {
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
      const res = cgraph('callers', [leafName]);
      r.step('cgraph_callers', `"${leafName}" → full caller tree`, res.elapsed, res.bytes);
      return r;
    }
  });

  // ── Scenario 2: "What's the impact of changing class X?" ─────
  scenarios.push({
    question: `What's the impact of changing ${className}?`,
    without(files) {
      const r = new AgentReplay(this.question);

      // Step 1: Find the class definition
      const t0 = performance.now();
      let defFile = null;
      for (const f of files) {
        const c = readFileSync(f, 'utf-8');
        if (c.includes(`class ${className}`)) { defFile = f; break; }
      }
      if (!defFile) defFile = files[0];
      r.step('grep_search', `"class ${className}" → ${rel(defFile)}`, performance.now() - t0, 600);

      // Step 2: Read the class
      const t1 = performance.now();
      const content = readFileSync(defFile, 'utf-8');
      r.step('read_file', `${rel(defFile)} (full class)`, performance.now() - t1, content.length);

      // Step 3: Find direct usages
      const t2 = performance.now();
      const usageFiles = [];
      for (const f of files) {
        const c = readFileSync(f, 'utf-8');
        if (c.includes(className) && f !== defFile) usageFiles.push(f);
      }
      r.step('grep_search', `"${className}" → ${usageFiles.length} files`, performance.now() - t2, 512);

      // Step 4: Read each usage file
      for (const uf of usageFiles) {
        const t = performance.now();
        const c = readFileSync(uf, 'utf-8');
        r.step('read_file', `${rel(uf)}`, performance.now() - t, Math.min(c.length, 4000));
      }

      // Step 5: Transitive callers (depth 2)
      const t3 = performance.now();
      const secondOrder = new Set();
      for (const uf of usageFiles) {
        const c = readFileSync(uf, 'utf-8');
        const funcNames = [...c.matchAll(/(?:export\s+)?(?:function|async\s+function)\s+(\w+)/g)].map(m => m[1]);
        for (const fn of funcNames) {
          for (const f of files) {
            const fc = readFileSync(f, 'utf-8');
            if (fc.includes(fn + '(')) secondOrder.add(rel(f));
          }
        }
      }
      r.step('grep_search', `transitive callers (depth 2) → ${secondOrder.size} files`, performance.now() - t3, 512 * secondOrder.size);

      // Step 6: Verify a few
      for (const sf of [...secondOrder].slice(0, 3)) {
        const t = performance.now();
        const c = readFileSync(resolve(TARGET, sf), 'utf-8');
        r.step('read_file', `${sf} (verify impact)`, performance.now() - t, Math.min(c.length, 3000));
      }

      return r;
    },
    withCgraph() {
      const r = new AgentReplay(this.question);
      const res = cgraph('impact', [className]);
      r.step('cgraph_impact', `"${className}" → full impact tree`, res.elapsed, res.bytes);
      return r;
    }
  });

  // ── Scenario 3: "Trace the call chain from entry to utility" ─
  scenarios.push({
    question: `How does ${entryName} reach ${utilName}?`,
    without(files) {
      const r = new AgentReplay(this.question);

      // Step 1: Find entry point
      const t0 = performance.now();
      let entryFile = null;
      for (const f of files) {
        const c = readFileSync(f, 'utf-8');
        if (c.includes(`function ${entryName}`) || c.includes(`${entryName}(`)) { entryFile = f; break; }
      }
      if (!entryFile) entryFile = files[0];
      r.step('file_search', `"${entryName}" → ${rel(entryFile)}`, performance.now() - t0, 256);

      // Step 2: Read entry file
      const t1 = performance.now();
      const entryContent = readFileSync(entryFile, 'utf-8');
      r.step('read_file', `${rel(entryFile)} (full file)`, performance.now() - t1, entryContent.length);

      // Step 3: Extract imports to follow chain
      const t2 = performance.now();
      const imports = [...entryContent.matchAll(/import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g)];
      r.step('semantic_search', `${entryName} imports: ${imports.length} modules`, performance.now() - t2, 512);

      // Step 4-6: Read imported modules to trace
      for (const imp of imports.slice(0, 4)) {
        const modName = imp[2].replace(/^\.\//, '').replace(/\.js$/, '');
        const modFile = files.find(f => f.includes(modName));
        if (modFile) {
          const t = performance.now();
          const c = readFileSync(modFile, 'utf-8');
          r.step('read_file', `${rel(modFile)} (trace chain)`, performance.now() - t, c.length);
        }
      }

      // Step 7: Grep for target utility
      const t3 = performance.now();
      for (const f of files) {
        const c = readFileSync(f, 'utf-8');
        if (c.includes(utilName)) {
          // scanning
        }
      }
      r.step('grep_search', `"${utilName}" across all files`, performance.now() - t3, 1024);

      return r;
    },
    withCgraph() {
      const r = new AgentReplay(this.question);
      const res = cgraph('trace', [entryName, utilName]);
      r.step('cgraph_trace', `"${entryName}" → "${utilName}" path`, res.elapsed, res.bytes);
      return r;
    }
  });

  // ── Scenario 4: "I changed X — what tests should I run?" ───
  scenarios.push({
    question: `I changed ${utilFileRel} — what tests should I run?`,
    without(files) {
      const r = new AgentReplay(this.question);
      const changedFile = sym.utilFile;

      // Step 1: Read the changed file
      const t0 = performance.now();
      const content = readFileSync(changedFile, 'utf-8');
      r.step('read_file', `${rel(changedFile)} (understand changes)`, performance.now() - t0, content.length);

      // Step 2: Extract exported symbols
      const t1 = performance.now();
      const exports = [...content.matchAll(/export\s+(?:function|const|class|interface|type)\s+(\w+)/g)].map(m => m[1]);
      r.step('grep_search', `exported symbols: ${exports.slice(0,5).join(', ')}`, performance.now() - t1, 512);

      // Step 3: For each export, grep who imports it
      const allFiles = walkFiles(TARGET, ['.ts','.js','.py','.tsx','.jsx','.test.ts']);
      const testFilesFound = [];
      for (const exp of exports) {
        for (const f of allFiles) {
          try {
            const c = readFileSync(f, 'utf-8');
            if (c.includes(exp) && f.includes('test')) testFilesFound.push(f);
          } catch {}
        }
      }
      const t2 = performance.now();
      r.step('grep_search', `find tests importing ${exports.length} symbols`, t2 - t1, 512 * exports.length);

      // Step 4: Find indirect dependents
      const t3 = performance.now();
      const dependents = [];
      const baseName = rel(changedFile).replace(/\.ts$/, '');
      for (const f of allFiles) {
        try {
          const c = readFileSync(f, 'utf-8');
          if (c.includes(baseName) || exports.some(e => c.includes(e))) {
            if (f !== changedFile) dependents.push(f);
          }
        } catch {}
      }
      r.step('grep_search', `dependents of ${rel(changedFile)} → ${dependents.length} files`, performance.now() - t3, 512);

      // Step 5: Find test files for dependents
      const t4 = performance.now();
      const indirectTests = new Set();
      for (const dep of dependents) {
        for (const f of allFiles) {
          if (f.includes('test')) indirectTests.add(rel(f));
        }
      }
      r.step('grep_search', `find tests for ${dependents.length} dependents`, performance.now() - t4, 512);

      // Step 6: Read a test file to verify
      const uniqueTests = [...new Set(testFilesFound)];
      if (uniqueTests.length > 0) {
        const t = performance.now();
        const c = readFileSync(uniqueTests[0], 'utf-8');
        r.step('read_file', `${rel(uniqueTests[0])} (verify relevance)`, performance.now() - t, Math.min(c.length, 3000));
      }

      return r;
    },
    withCgraph() {
      const r = new AgentReplay(this.question);
      const res = cgraph('affected', [utilFileRel]);
      r.step('cgraph_affected', `"${utilFileRel}" → affected test mapping`, res.elapsed, res.bytes);
      return r;
    }
  });

  // ── Scenario 5: "Explain the architecture" ──
  scenarios.push({
    question: 'Explain the architecture and how modules connect.',
    without(files) {
      const r = new AgentReplay(this.question);

      // Step 1: List project structure
      const t0 = performance.now();
      r.step('list_dir', `src/ → ${files.length} source files`, performance.now() - t0, files.map(rel).join('\n').length);

      // Step 2-6: Read each source file to understand structure
      const majorFiles = files.slice(0, 5);
      for (const f of majorFiles) {
        const t = performance.now();
        const c = readFileSync(f, 'utf-8');
        r.step('read_file', `${rel(f)} (understand module)`, performance.now() - t, c.length);
      }

      // Step 7: Read remaining files
      const remaining = files.slice(5, 9);
      for (const f of remaining) {
        const t = performance.now();
        const c = readFileSync(f, 'utf-8');
        r.step('read_file', `${rel(f)} (complete picture)`, performance.now() - t, c.length);
      }

      // Step 8: Grep for cross-module imports
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
      const res1 = cgraph('explore', ['src']);
      r.step('cgraph_explore', `"src" → module overview`, res1.elapsed, res1.bytes);
      const res2 = cgraph('files', []);
      r.step('cgraph_files', `file stats + edge density`, res2.elapsed, res2.bytes);
      return r;
    }
  });
}

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

  // Build scenarios from detected symbols
  buildScenarios(files);
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
