#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';

import { indexProject } from '../dist/indexer.js';
import { GraphDB } from '../dist/storage.js';
import { getDbPath } from '../dist/config.js';
import { buildContext } from '../dist/context.js';
import { findCallers, analyzeImpact, getCodebaseDNA } from '../dist/graph.js';
import { searchSymbols } from '../dist/search.js';
import { SmartCrusher } from '../dist/compression/SmartCrusher.js';
import { CodeCompressor } from '../dist/compression/CodeCompressor.js';

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
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.cgraph') continue;
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

function applyCodeCompression(data, mode = 'coding') {
  if (typeof data === 'string') {
    if (data.length > 300 && (data.includes('\n') || data.includes('function') || data.includes('class') || data.includes('=>'))) {
      return CodeCompressor.skeletonize(data, mode);
    }
    return data;
  }
  if (Array.isArray(data)) return data.map((x) => applyCodeCompression(x, mode));
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = applyCodeCompression(v, mode);
    return out;
  }
  return data;
}

function runWithoutCgraph(repoDir, symbol, query) {
  const files = listSourceFiles(repoDir);
  let fileReads = 0;
  let bytesRead = 0;

  const t0 = performance.now();

  // Task A: caller-like discovery (grep all files)
  const callerMatches = [];
  const callPattern = new RegExp(`\\b${symbol}\\s*\\(`, 'g');
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    fileReads++;
    bytesRead += Buffer.byteLength(txt, 'utf8');
    const m = txt.match(callPattern);
    if (m && m.length) callerMatches.push({ file: path.relative(repoDir, f), count: m.length });
  }

  // Task B: impact-like discovery (all references)
  const refMatches = [];
  const refPattern = new RegExp(`\\b${symbol}\\b`, 'g');
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    fileReads++;
    bytesRead += Buffer.byteLength(txt, 'utf8');
    const m = txt.match(refPattern);
    if (m && m.length) refMatches.push({ file: path.relative(repoDir, f), count: m.length });
  }

  // Task C: architecture-like summary (imports/exports scanning)
  let imports = 0;
  let exports = 0;
  const importRe = /\bimport\b/g;
  const exportRe = /\bexport\b/g;
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    fileReads++;
    bytesRead += Buffer.byteLength(txt, 'utf8');
    imports += (txt.match(importRe) || []).length;
    exports += (txt.match(exportRe) || []).length;
  }

  const t1 = performance.now();
  const payload = {
    callers: callerMatches.slice(0, 40),
    impact_refs: refMatches.slice(0, 80),
    architecture: { files: files.length, imports, exports, query },
  };

  return {
    label: 'without_cgraph',
    computeMs: t1 - t0,
    outputBytes: bytesOf(payload),
    fileReads,
    bytesRead,
  };
}

function runWithCgraphRaw(db, repoDir, symbol, query) {
  const t0 = performance.now();

  const seed = searchSymbols(db, symbol, { limit: 1 })[0]?.node?.id;
  const callers = seed ? findCallers(db, symbol, { maxDepth: 3, maxNodes: 120 }) : { nodes: [], edges: [], truncated: false };
  const impact = analyzeImpact(db, symbol, { maxDepth: 3, maxNodes: 200 });
  const context = buildContext(db, repoDir, query, { maxNodes: 80, maxDepth: 3 });
  const dna = getCodebaseDNA(db);

  const payload = { callers, impact, context, dna };
  const t1 = performance.now();

  return {
    label: 'cgraph_raw',
    computeMs: t1 - t0,
    outputBytes: bytesOf(payload),
    fileReads: 0,
    bytesRead: 0,
    payload,
  };
}

function runWithCgraphCompressed(rawPayload) {
  const t0 = performance.now();
  const crushed = SmartCrusher.crush(rawPayload, 'coding', 'standard');
  const compressed = applyCodeCompression(crushed, 'coding');
  const t1 = performance.now();

  return {
    label: 'cgraph_compressed',
    computeMs: t1 - t0,
    outputBytes: bytesOf(compressed),
    fileReads: 0,
    bytesRead: 0,
  };
}

function line(cols) {
  return cols.map((c) => String(c)).join('  ');
}

async function main() {
  const repoUrl = process.argv[2] || 'https://github.com/axios/axios.git';
  const symbol = process.argv[3] || 'request';
  const query = process.argv[4] || 'request interceptors flow';

  const root = process.cwd();
  const repoDir = path.join(root, '.bench', 'repos', repoNameFromUrl(repoUrl));

  console.log('=== Three-way Benchmark ===');
  console.log(`repo:   ${repoUrl}`);
  console.log(`local:  ${repoDir}`);
  console.log(`symbol: ${symbol}`);
  console.log(`query:  ${query}`);
  console.log('');

  ensureRepo(repoUrl, repoDir);

  const idx0 = performance.now();
  const idx = await indexProject(repoDir, { force: false });
  const idx1 = performance.now();
  console.log(`index: files_scanned=${idx.files_scanned}, files_changed=${idx.files_changed}, ms=${Math.round(idx1 - idx0)}`);

  const db = await GraphDB.open(getDbPath(repoDir));

  const noCg = runWithoutCgraph(repoDir, symbol, query);
  const raw = runWithCgraphRaw(db, repoDir, symbol, query);
  const cmp = runWithCgraphCompressed(raw.payload);

  db.close();

  const compressionSavings = raw.outputBytes - cmp.outputBytes;
  const compressionPct = raw.outputBytes === 0 ? 0 : (compressionSavings / raw.outputBytes) * 100;

  console.log('');
  console.log('Comparison:');
  console.log(line(['mode'.padEnd(20), 'compute_ms'.padEnd(10), 'out_size'.padEnd(12), 'file_reads'.padEnd(10), 'bytes_read']));
  console.log(line([
    noCg.label.padEnd(20),
    Math.round(noCg.computeMs).toString().padEnd(10),
    humanBytes(noCg.outputBytes).padEnd(12),
    String(noCg.fileReads).padEnd(10),
    humanBytes(noCg.bytesRead),
  ]));
  console.log(line([
    raw.label.padEnd(20),
    Math.round(raw.computeMs).toString().padEnd(10),
    humanBytes(raw.outputBytes).padEnd(12),
    String(raw.fileReads).padEnd(10),
    humanBytes(raw.bytesRead),
  ]));
  console.log(line([
    cmp.label.padEnd(20),
    Math.round(cmp.computeMs).toString().padEnd(10),
    humanBytes(cmp.outputBytes).padEnd(12),
    String(cmp.fileReads).padEnd(10),
    humanBytes(cmp.bytesRead),
  ]));

  console.log('');
  console.log('Derived metrics:');
  console.log(`- cgraph vs no-cgraph compute ratio: ${(raw.computeMs / Math.max(noCg.computeMs, 0.001)).toFixed(2)}x`);
  console.log(`- compression savings on cgraph payload: ${humanBytes(compressionSavings)} (${compressionPct.toFixed(1)}%)`);
  console.log(`- no-cgraph file I/O avoided by cgraph: ${noCg.fileReads} reads, ${humanBytes(noCg.bytesRead)} read`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
