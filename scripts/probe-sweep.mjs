#!/usr/bin/env node
/**
 * probe-sweep.mjs
 *
 * Cheap pre-flight probe: runs exactly 1 scenario per mode per repo and
 * reports response characteristics (size, sections present, signal, elapsed).
 * No repeats, no statistics. Use this before a full benchmark run to validate
 * that the graph and compression pipeline are behaving as expected.
 *
 * Usage:
 *   node scripts/probe-sweep.mjs [repoUrl] [taskPack]
 *
 * Examples:
 *   node scripts/probe-sweep.mjs
 *   node scripts/probe-sweep.mjs https://github.com/expressjs/express.git flow
 *   node scripts/probe-sweep.mjs https://github.com/axios/axios.git mixed
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';

import { indexProject } from '../dist/indexer.js';
import { GraphDB } from '../dist/storage.js';
import { getDbPath } from '../dist/config.js';
import { buildContext } from '../dist/context.js';
import { findCallers, analyzeImpact, getCodebaseDNA } from '../dist/graph.js';
import { SmartCrusher } from '../dist/compression/SmartCrusher.js';
import { CodeCompressor } from '../dist/compression/CodeCompressor.js';

// ---- helpers ----------------------------------------------------------------

function repoNameFromUrl(url) {
  const last = url.replace(/\/$/, '').split('/').pop() || 'repo';
  return last.endsWith('.git') ? last.slice(0, -4) : last;
}

function ensureRepo(repoUrl, repoDir) {
  if (fs.existsSync(repoDir)) return;
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execSync(`git clone --depth 1 ${repoUrl} "${repoDir}"`, { stdio: 'inherit' });
}

function listSourceFiles(rootDir) {
  const out = [];
  const exts = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.cgraph' || ent.name === 'dist') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (exts.has(path.extname(ent.name))) out.push(abs);
    }
  }
  walk(rootDir);
  return out;
}

function bytesOf(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function countAny(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.nodes)) return value.nodes.length;
    if (Array.isArray(value.items)) return value.items.length;
    return Object.keys(value).length;
  }
  return value ? 1 : 0;
}

// Detect which top-level sections exist in a JSON payload
function detectSections(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const known = ['callers', 'impact', 'context', 'dna', 'codeBlocks', 'entryPoints', 'relatedFiles', 'callPaths', 'blastRadius'];
  const present = [];
  for (const key of known) {
    if (key in payload) {
      const val = payload[key];
      present.push(`${key}(${countAny(val)})`);
    }
    // Also check nested context
    if (payload.context && typeof payload.context === 'object' && key in payload.context) {
      const val = payload.context[key];
      if (!present.some((p) => p.startsWith(key + '('))) {
        present.push(`ctx.${key}(${countAny(val)})`);
      }
    }
  }
  return present;
}

const TASK_TEMPLATES = {
  flow: [
    { id: 'edit-impact', group: 'flow', query: (s, r) => `I will modify ${s} in ${r}. What downstream symbols are impacted?` },
    { id: 'edit-callers', group: 'flow', query: (s, r) => `I changed ${s} in ${r}. Show caller chains.` },
  ],
  control: [
    { id: 'control-architecture', group: 'control', query: (s, r) => `Architecture overview around ${s} in ${r}.` },
    { id: 'control-risk', group: 'control', query: (s, r) => `Change risk survey for ${s} in ${r}.` },
  ],
};

function getTemplates(pack) {
  if (pack === 'flow') return TASK_TEMPLATES.flow;
  if (pack === 'control') return TASK_TEMPLATES.control;
  return [...TASK_TEMPLATES.flow, ...TASK_TEMPLATES.control];
}

// ---- probe modes ------------------------------------------------------------

function probeNaive(files, symbol, query) {
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const t0 = performance.now();
  let hits = 0;
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    hits += (txt.match(re) || []).length;
  }
  const ms = performance.now() - t0;
  return { mode: 'naive', ms: ms.toFixed(1), size: humanBytes(files.length * 200), files: files.length, signal: hits, sections: ['full_scan'] };
}

function probeSmartSearch(files, symbol, query) {
  const identRe = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  const idx = new Map();
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const ident of new Set(txt.match(identRe) || [])) {
      const b = idx.get(ident);
      if (b) b.push(f);
      else idx.set(ident, [f]);
    }
  }
  const direct = idx.get(symbol);
  const candidates = direct?.length ? direct : files.slice(0, 20);
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const t0 = performance.now();
  let hits = 0;
  for (const f of candidates) hits += (fs.readFileSync(f, 'utf8').match(re) || []).length;
  const ms = performance.now() - t0;
  return { mode: 'smart', ms: ms.toFixed(1), size: humanBytes(candidates.length * 200), files: candidates.length, signal: hits, sections: [direct ? 'direct_match' : 'fallback'] };
}

async function probeCgraphRaw(db, repoDir, symbol, query) {
  const t0 = performance.now();
  const callers = findCallers(db, symbol, { maxDepth: 3, maxNodes: 120 });
  const impact = analyzeImpact(db, symbol, { maxDepth: 3, maxNodes: 200 });
  const context = buildContext(db, repoDir, query, { maxNodes: 80, maxDepth: 3 });
  const dna = getCodebaseDNA(db);
  const payload = { callers, impact, context, dna };
  const ms = performance.now() - t0;
  const sections = detectSections(payload);
  const signal = countAny(callers) + countAny(impact);
  return { mode: 'cgraph_raw', ms: ms.toFixed(1), size: humanBytes(bytesOf(payload)), files: 0, signal, sections };
}

async function probeCgraphCompressed(db, repoDir, symbol, query) {
  const t0 = performance.now();
  const callers = findCallers(db, symbol, { maxDepth: 3, maxNodes: 120 });
  const impact = analyzeImpact(db, symbol, { maxDepth: 3, maxNodes: 200 });
  const context = buildContext(db, repoDir, query, { maxNodes: 80, maxDepth: 3 });
  const dna = getCodebaseDNA(db);
  const payload = { callers, impact, context, dna };
  const rawBytes = bytesOf(payload);
  const crushed = SmartCrusher.crush(payload, 'coding', 'standard');
  const compressed = crushed;
  const cmpBytes = bytesOf(compressed);
  const ms = performance.now() - t0;
  const sections = detectSections(compressed);
  const savingsPct = rawBytes > 0 ? ((rawBytes - cmpBytes) / rawBytes * 100).toFixed(1) : '0.0';
  return { mode: 'cgraph_compressed', ms: ms.toFixed(1), size: humanBytes(cmpBytes), files: 0, signal: countAny(callers) + countAny(impact), sections, extra: `savings=${savingsPct}%` };
}

// ---- main -------------------------------------------------------------------

async function main() {
  const repoUrl = process.argv[2] || 'https://github.com/expressjs/express.git';
  const taskPack = (process.argv[3] || 'mixed').toLowerCase();

  const root = process.cwd();
  const repoDir = path.join(root, '.bench', 'repos', repoNameFromUrl(repoUrl));
  const repoName = repoNameFromUrl(repoUrl);

  console.log('=== probe-sweep ===');
  console.log(`repo:      ${repoUrl}`);
  console.log(`task_pack: ${taskPack}`);
  console.log('');

  ensureRepo(repoUrl, repoDir);

  const t0 = performance.now();
  const idx = await indexProject(repoDir, { force: false });
  console.log(`index: files_scanned=${idx.files_scanned} files_changed=${idx.files_changed} ms=${Math.round(performance.now() - t0)}`);

  const db = await GraphDB.open(getDbPath(repoDir));
  const nodes = db.getAllNodes();
  const files = listSourceFiles(repoDir);

  console.log(`graph: nodes=${nodes.length} files=${files.length}`);
  console.log('');

  if (nodes.length === 0) {
    console.log('No nodes found — check indexer output.');
    db.close();
    return;
  }

  const templates = getTemplates(taskPack);

  // Pick one scenario per template
  const scenarios = templates.map((tmpl, i) => {
    const node = nodes[Math.floor((i / templates.length) * nodes.length)];
    const fileRec = db.getFileById(node.file_id);
    const relPath = fileRec?.path || 'unknown';
    return { symbol: node.name, relPath, taskId: tmpl.id, taskGroup: tmpl.group, query: tmpl.query(node.name, relPath) };
  });

  console.log('Scenarios:');
  for (const sc of scenarios) {
    console.log(`  [${sc.taskId}] symbol="${sc.symbol}" file="${sc.relPath}"`);
  }
  console.log('');

  const results = [];
  for (const sc of scenarios) {
    console.log(`--- ${sc.taskId} (${sc.symbol}) ---`);
    const naive = probeNaive(files, sc.symbol, sc.query);
    const smart = probeSmartSearch(files, sc.symbol, sc.query);
    const raw = await probeCgraphRaw(db, repoDir, sc.symbol, sc.query);
    const cmp = await probeCgraphCompressed(db, repoDir, sc.symbol, sc.query);

    for (const r of [naive, smart, raw, cmp]) {
      const extra = r.extra ? `  ${r.extra}` : '';
      console.log(
        `  ${r.mode.padEnd(18)} ms=${String(r.ms).padStart(7)}  size=${humanBytes(parseInt(r.size)).padStart(9)}  signal=${String(r.signal).padStart(4)}  sections=[${r.sections.join(', ')}]${extra}`,
      );
    }
    results.push({ scenario: sc, naive, smart, raw, compressed: cmp });
    console.log('');
  }

  // Summary table
  console.log('Summary:');
  console.log('mode'.padEnd(20) + '  avg_ms    avg_size   avg_signal  sections_hit');
  const modes = ['naive', 'smart', 'cgraph_raw', 'cgraph_compressed'];
  const modeKeys = { naive: 'naive', smart: 'smart', cgraph_raw: 'raw', cgraph_compressed: 'compressed' };
  for (const mode of modes) {
    const key = modeKeys[mode] || mode;
    const rows = results.map((r) => r[key] || r.naive);
    const avgMs = rows.reduce((s, r) => s + parseFloat(r.ms), 0) / rows.length;
    const avgSig = rows.reduce((s, r) => s + (r.signal || 0), 0) / rows.length;
    const secHit = rows.filter((r) => (r.signal || 0) > 0).length;
    console.log(`  ${mode.padEnd(18)}  ${avgMs.toFixed(1).padStart(6)}ms  ${String('').padStart(9)}  ${avgSig.toFixed(1).padStart(8)}    ${secHit}/${rows.length}`);
  }

  db.close();
  console.log('');
  console.log('probe-sweep complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
