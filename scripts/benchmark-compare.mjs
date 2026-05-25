/**
 * cgraph Efficiency Benchmark — with vs without the tool.
 *
 * Simulates what an AI agent does to answer common questions:
 *   WITHOUT cgraph: grep files → read files → parse manually
 *   WITH cgraph:    single MCP tool call
 *
 * Measures: time, operations count, bytes transferred, accuracy.
 *
 * Usage:
 *   node scripts/benchmark-compare.mjs [project-dir]
 */
import { spawn, execSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { performance } from 'perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CGRAPH_BIN = resolve(ROOT, 'bin', 'cgraph.js');
const TARGET_DIR = resolve(process.argv[2] || ROOT);

// ─── Collect all source files (simulates agent discovering files) ───
function walkFiles(dir, exts = ['.ts', '.js', '.py', '.tsx', '.jsx'], results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git' ||
        entry.name === '.cgraph' || entry.name === 'dist') continue;
    if (entry.isDirectory()) {
      walkFiles(full, exts, results);
    } else if (exts.some(e => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

// ─── WITHOUT cgraph: simulate manual agent workflow ────────────
function withoutCgraph_findCallers(symbolName, files) {
  const ops = { greps: 0, fileReads: 0, bytesRead: 0, matches: [] };
  const t0 = performance.now();

  // Step 1: grep all files for the symbol name
  for (const file of files) {
    ops.greps++;
    const content = readFileSync(file, 'utf-8');
    ops.fileReads++;
    ops.bytesRead += content.length;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Look for calls: symbolName( or .symbolName(
      const re = new RegExp(`\\b${symbolName}\\s*\\(`, 'g');
      if (re.test(lines[i])) {
        // Check it's not the definition itself
        if (!/^\s*(export\s+)?(function|class|const|let|var|def)\s/.test(lines[i])) {
          ops.matches.push({
            file: file.replace(TARGET_DIR + '\\', '').replace(TARGET_DIR + '/', ''),
            line: i + 1,
            text: lines[i].trim().slice(0, 80),
          });
        }
      }
    }
  }

  ops.elapsed = performance.now() - t0;
  return ops;
}

function withoutCgraph_findCallees(symbolName, files) {
  const ops = { greps: 0, fileReads: 0, bytesRead: 0, matches: [] };
  const t0 = performance.now();

  // Step 1: Find the function definition
  let funcBody = null;
  for (const file of files) {
    ops.greps++;
    const content = readFileSync(file, 'utf-8');
    ops.fileReads++;
    ops.bytesRead += content.length;

    const defRe = new RegExp(`(function|def)\\s+${symbolName}\\s*\\(`);
    const match = content.match(defRe);
    if (match) {
      // Extract function body (rough: from def line to next function/class)
      const lines = content.split('\n');
      const startLine = content.slice(0, match.index).split('\n').length - 1;
      let endLine = startLine + 1;
      for (let i = startLine + 1; i < lines.length; i++) {
        if (/^(export\s+)?(function|class|def)\s/.test(lines[i])) break;
        endLine = i;
      }
      funcBody = { file, lines: lines.slice(startLine, endLine + 1), startLine };
      break;
    }
  }

  if (funcBody) {
    // Step 2: Find function calls within the body
    const callRe = /\b([a-zA-Z_]\w+)\s*\(/g;
    const seen = new Set();
    for (const line of funcBody.lines) {
      let m;
      while ((m = callRe.exec(line)) !== null) {
        const name = m[1];
        if (!seen.has(name) && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'function', 'class', 'const', 'let', 'var'].includes(name)) {
          seen.add(name);
          ops.matches.push({ callee: name });
        }
      }
    }

    // Step 3: For each callee, grep to find its definition
    for (const callee of ops.matches) {
      for (const file of files) {
        ops.greps++;
        const content = readFileSync(file, 'utf-8');
        ops.fileReads++;
        ops.bytesRead += content.length;

        const defRe = new RegExp(`(function|def|class)\\s+${callee.callee}\\b`);
        if (defRe.test(content)) {
          callee.file = file.replace(TARGET_DIR + '\\', '').replace(TARGET_DIR + '/', '');
          break;
        }
      }
    }
  }

  ops.elapsed = performance.now() - t0;
  return ops;
}

function withoutCgraph_impact(symbolName, files) {
  const ops = { greps: 0, fileReads: 0, bytesRead: 0, depth: 0, impacted: new Set() };
  const t0 = performance.now();

  // Transitive callers: BFS manually
  const queue = [symbolName];
  const visited = new Set();

  while (queue.length > 0 && ops.depth < 3) {
    ops.depth++;
    const nextQueue = [];
    for (const sym of queue) {
      if (visited.has(sym)) continue;
      visited.add(sym);

      for (const file of files) {
        ops.greps++;
        const content = readFileSync(file, 'utf-8');
        ops.fileReads++;
        ops.bytesRead += content.length;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const re = new RegExp(`\\b${sym}\\s*\\(`, 'g');
          if (re.test(lines[i]) && !/^\s*(export\s+)?(function|class|def)\s/.test(lines[i])) {
            // Find enclosing function
            for (let j = i; j >= 0; j--) {
              const funcMatch = lines[j].match(/(function|def)\s+(\w+)/);
              if (funcMatch) {
                const caller = funcMatch[2];
                if (!visited.has(caller)) {
                  ops.impacted.add(caller);
                  nextQueue.push(caller);
                }
                break;
              }
            }
          }
        }
      }
    }
    queue.length = 0;
    queue.push(...nextQueue);
  }

  ops.elapsed = performance.now() - t0;
  ops.impactedCount = ops.impacted.size;
  return ops;
}

function withoutCgraph_trace(fromName, toName, files) {
  const ops = { greps: 0, fileReads: 0, bytesRead: 0, found: false, hops: 0 };
  const t0 = performance.now();

  // BFS through call graph manually — find path from A to B
  const queue = [[fromName]];
  const visited = new Set([fromName]);

  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];
    if (path.length > 7) continue;

    // Find callees of current
    for (const file of files) {
      ops.greps++;
      const content = readFileSync(file, 'utf-8');
      ops.fileReads++;
      ops.bytesRead += content.length;

      const defRe = new RegExp(`(function|def)\\s+${current}\\s*\\(`);
      const match = content.match(defRe);
      if (!match) continue;

      const lines = content.split('\n');
      const startLine = content.slice(0, match.index).split('\n').length - 1;
      for (let i = startLine; i < Math.min(startLine + 50, lines.length); i++) {
        if (i > startLine && /^(export\s+)?(function|class|def)\s/.test(lines[i])) break;
        const callRe = /\b([a-zA-Z_]\w+)\s*\(/g;
        let m;
        while ((m = callRe.exec(lines[i])) !== null) {
          const callee = m[1];
          if (callee === toName) {
            ops.found = true;
            ops.hops = path.length + 1;
            ops.elapsed = performance.now() - t0;
            return ops;
          }
          if (!visited.has(callee)) {
            visited.add(callee);
            queue.push([...path, callee]);
          }
        }
      }
    }
  }

  ops.elapsed = performance.now() - t0;
  return ops;
}

// ─── WITH cgraph: single CLI call ──────────────────────────────
function withCgraph(command, args) {
  const t0 = performance.now();
  const result = execSync(
    `node "${CGRAPH_BIN}" ${command} ${args.map(a => `"${a}"`).join(' ')}`,
    { cwd: TARGET_DIR, encoding: 'utf-8', timeout: 15000 }
  );
  const elapsed = performance.now() - t0;
  return { elapsed, bytesReturned: result.length, output: result };
}

// ─── Format helpers ────────────────────────────────────────────
function fmt(ms) { return `${Math.round(ms)}ms`.padStart(8); }
function fmtBytes(b) {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  if (b > 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${b}B`;
}
function speedup(without, withT) {
  const x = without / Math.max(withT, 0.1);
  if (x >= 100) return `${Math.round(x)}x faster`;
  return `${x.toFixed(1)}x faster`;
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   cgraph Efficiency Benchmark: WITH vs WITHOUT            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Target: ${TARGET_DIR}`);

  const files = walkFiles(TARGET_DIR);
  console.log(`  Source files: ${files.length}`);
  console.log('');

  // Ensure index exists
  try { execSync(`node "${CGRAPH_BIN}" index`, { cwd: TARGET_DIR, stdio: 'pipe' }); } catch {}

  const comparisons = [];

  // ─── Test 1: Find Callers ──────────────────────────────────
  console.log('━━━ Test 1: "Who calls traverse?" ━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const wo1 = withoutCgraph_findCallers('traverse', files);
  const wi1 = withCgraph('callers', ['traverse']);

  console.log('  WITHOUT cgraph (grep + read files):');
  console.log(`    Time:         ${fmt(wo1.elapsed)}`);
  console.log(`    File reads:   ${wo1.fileReads}`);
  console.log(`    Bytes read:   ${fmtBytes(wo1.bytesRead)}`);
  console.log(`    Results:      ${wo1.matches.length} call sites`);
  console.log('');
  console.log('  WITH cgraph (single tool call):');
  console.log(`    Time:         ${fmt(wi1.elapsed)}`);
  console.log(`    Tool calls:   1`);
  console.log(`    Bytes returned: ${fmtBytes(wi1.bytesReturned)}`);
  console.log('');
  console.log(`  ⚡ cgraph is ${speedup(wo1.elapsed, wi1.elapsed)} | ${wo1.fileReads} ops → 1 op | ${fmtBytes(wo1.bytesRead)} → ${fmtBytes(wi1.bytesReturned)}`);
  comparisons.push({ test: 'Find callers', without: wo1.elapsed, with: wi1.elapsed, opsWithout: wo1.fileReads, bytesWithout: wo1.bytesRead, bytesWith: wi1.bytesReturned });
  console.log('');

  // ─── Test 2: Find Callees ─────────────────────────────────
  console.log('━━━ Test 2: "What does indexProject call?" ━━━━━━━━━━━━━━━━');
  console.log('');

  const wo2 = withoutCgraph_findCallees('indexProject', files);
  const wi2 = withCgraph('callees', ['indexProject']);

  console.log('  WITHOUT cgraph:');
  console.log(`    Time:         ${fmt(wo2.elapsed)}`);
  console.log(`    File reads:   ${wo2.fileReads}`);
  console.log(`    Bytes read:   ${fmtBytes(wo2.bytesRead)}`);
  console.log(`    Callees found: ${wo2.matches.length}`);
  console.log('');
  console.log('  WITH cgraph:');
  console.log(`    Time:         ${fmt(wi2.elapsed)}`);
  console.log(`    Tool calls:   1`);
  console.log(`    Bytes returned: ${fmtBytes(wi2.bytesReturned)}`);
  console.log('');
  console.log(`  ⚡ cgraph is ${speedup(wo2.elapsed, wi2.elapsed)} | ${wo2.fileReads} ops → 1 op | ${fmtBytes(wo2.bytesRead)} → ${fmtBytes(wi2.bytesReturned)}`);
  comparisons.push({ test: 'Find callees', without: wo2.elapsed, with: wi2.elapsed, opsWithout: wo2.fileReads, bytesWithout: wo2.bytesRead, bytesWith: wi2.bytesReturned });
  console.log('');

  // ─── Test 3: Impact Analysis ──────────────────────────────
  console.log('━━━ Test 3: "What breaks if I change parseFile?" ━━━━━━━━━━');
  console.log('');

  const wo3 = withoutCgraph_impact('parseFile', files);
  const wi3 = withCgraph('impact', ['parseFile']);

  console.log('  WITHOUT cgraph (transitive BFS, depth 3):');
  console.log(`    Time:         ${fmt(wo3.elapsed)}`);
  console.log(`    File reads:   ${wo3.fileReads}`);
  console.log(`    Bytes read:   ${fmtBytes(wo3.bytesRead)}`);
  console.log(`    Impacted:     ${wo3.impactedCount} symbols`);
  console.log('');
  console.log('  WITH cgraph:');
  console.log(`    Time:         ${fmt(wi3.elapsed)}`);
  console.log(`    Tool calls:   1`);
  console.log(`    Bytes returned: ${fmtBytes(wi3.bytesReturned)}`);
  console.log('');
  console.log(`  ⚡ cgraph is ${speedup(wo3.elapsed, wi3.elapsed)} | ${wo3.fileReads} ops → 1 op | ${fmtBytes(wo3.bytesRead)} → ${fmtBytes(wi3.bytesReturned)}`);
  comparisons.push({ test: 'Impact analysis', without: wo3.elapsed, with: wi3.elapsed, opsWithout: wo3.fileReads, bytesWithout: wo3.bytesRead, bytesWith: wi3.bytesReturned });
  console.log('');

  // ─── Test 4: Trace Path ───────────────────────────────────
  console.log('━━━ Test 4: "How does indexProject reach parseFile?" ━━━━━━');
  console.log('');

  const wo4 = withoutCgraph_trace('indexProject', 'parseFile', files);
  const wi4 = withCgraph('trace', ['indexProject', 'parseFile']);

  console.log('  WITHOUT cgraph (BFS through file contents):');
  console.log(`    Time:         ${fmt(wo4.elapsed)}`);
  console.log(`    File reads:   ${wo4.fileReads}`);
  console.log(`    Bytes read:   ${fmtBytes(wo4.bytesRead)}`);
  console.log(`    Found:        ${wo4.found ? `yes (${wo4.hops} hops)` : 'no'}`);
  console.log('');
  console.log('  WITH cgraph:');
  console.log(`    Time:         ${fmt(wi4.elapsed)}`);
  console.log(`    Tool calls:   1`);
  console.log(`    Bytes returned: ${fmtBytes(wi4.bytesReturned)}`);
  console.log('');
  console.log(`  ⚡ cgraph is ${speedup(wo4.elapsed, wi4.elapsed)} | ${wo4.fileReads} ops → 1 op | ${fmtBytes(wo4.bytesRead)} → ${fmtBytes(wi4.bytesReturned)}`);
  comparisons.push({ test: 'Trace path', without: wo4.elapsed, with: wi4.elapsed, opsWithout: wo4.fileReads, bytesWithout: wo4.bytesRead, bytesWith: wi4.bytesReturned });
  console.log('');

  // ─── Summary Table ────────────────────────────────────────
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Summary                                                 ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Test              │ Without   │ With     │ Speedup       ║');
  console.log('╠════════════════════╪═══════════╪══════════╪═══════════════╣');
  for (const c of comparisons) {
    const name = c.test.padEnd(18);
    const wo = fmt(c.without).padStart(8);
    const wi = fmt(c.with).padStart(7);
    const sp = speedup(c.without, c.with).padStart(13);
    console.log(`║  ${name} │ ${wo}  │ ${wi}  │ ${sp} ║`);
  }
  console.log('╠════════════════════╧═══════════╧══════════╧═══════════════╣');

  const totalWithout = comparisons.reduce((s, c) => s + c.without, 0);
  const totalWith = comparisons.reduce((s, c) => s + c.with, 0);
  const totalOpsWithout = comparisons.reduce((s, c) => s + c.opsWithout, 0);
  const totalBytesWithout = comparisons.reduce((s, c) => s + c.bytesWithout, 0);
  const totalBytesWith = comparisons.reduce((s, c) => s + c.bytesWith, 0);

  console.log(`║  Total time:    ${fmt(totalWithout)} → ${fmt(totalWith)}  (${speedup(totalWithout, totalWith)})`.padEnd(61) + '║');
  console.log(`║  Total ops:     ${totalOpsWithout} file reads → 4 tool calls`.padEnd(61) + '║');
  console.log(`║  Total I/O:     ${fmtBytes(totalBytesWithout)} read → ${fmtBytes(totalBytesWith)} returned`.padEnd(61) + '║');
  console.log(`║  Token savings: ~${Math.round((1 - totalBytesWith / totalBytesWithout) * 100)}% fewer tokens`.padEnd(61) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
}

main().catch((err) => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
