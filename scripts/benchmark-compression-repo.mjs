#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { performance } from 'perf_hooks';

import { indexProject } from '../dist/indexer.js';
import { GraphDB } from '../dist/storage.js';
import { getDbPath } from '../dist/config.js';
import { buildContext, explore } from '../dist/context.js';
import { getProjectStats, getCodebaseDNA } from '../dist/graph.js';
import { SmartCrusher } from '../dist/compression/SmartCrusher.js';
import { CodeCompressor } from '../dist/compression/CodeCompressor.js';

function usage() {
  console.log('Usage: node scripts/benchmark-compression-repo.mjs [repoUrl] [query]');
  console.log('Example: node scripts/benchmark-compression-repo.mjs https://github.com/axios/axios.git "interceptors request response"');
}

function repoNameFromUrl(url) {
  const last = url.replace(/\/$/, '').split('/').pop() || 'repo';
  return last.endsWith('.git') ? last.slice(0, -4) : last;
}

function ensureRepoCloned(repoUrl, targetDir) {
  if (fs.existsSync(targetDir)) return;
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  execSync(`git clone --depth 1 ${repoUrl} "${targetDir}"`, { stdio: 'inherit' });
}

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function applyCodeCompression(data, mode) {
  if (typeof data === 'string') {
    if (data.length > 300 && (data.includes('\n') || data.includes('function') || data.includes('class') || data.includes('=>'))) {
      return CodeCompressor.skeletonize(data, mode);
    }
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((x) => applyCodeCompression(x, mode));
  }
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = applyCodeCompression(v, mode);
    return out;
  }
  return data;
}

function benchmarkPayload(name, payload, mode = 'coding', capacity = 'standard') {
  const rawBytes = bytesOf(payload);

  const t0 = performance.now();
  const crushed = SmartCrusher.crush(payload, mode, capacity);
  const compressed = applyCodeCompression(crushed, mode);
  const t1 = performance.now();

  const compressedBytes = bytesOf(compressed);
  const ratio = rawBytes === 0 ? 1 : compressedBytes / rawBytes;

  return {
    name,
    rawBytes,
    compressedBytes,
    bytesSaved: rawBytes - compressedBytes,
    compressionRatio: ratio,
    compressMs: t1 - t0,
  };
}

async function main() {
  const repoUrl = process.argv[2] || 'https://github.com/axios/axios.git';
  const query = process.argv[3] || 'interceptor request response';

  const root = process.cwd();
  const benchRoot = path.join(root, '.bench', 'repos');
  const repoName = repoNameFromUrl(repoUrl);
  const repoDir = path.join(benchRoot, repoName);

  console.log('=== Compression Benchmark (Popular Repo) ===');
  console.log(`Repo URL: ${repoUrl}`);
  console.log(`Repo Dir: ${repoDir}`);
  console.log('');

  ensureRepoCloned(repoUrl, repoDir);

  const indexStart = performance.now();
  const idx = await indexProject(repoDir, { force: false });
  const indexMs = performance.now() - indexStart;

  const dbPath = getDbPath(repoDir);
  const db = await GraphDB.open(dbPath);

  const tasks = [];

  const statusPayload = {
    status: db.getStatus(repoDir),
  };
  tasks.push(benchmarkPayload('status', statusPayload));

  const statsPayload = getProjectStats(db);
  tasks.push(benchmarkPayload('stats', statsPayload));

  const dnaPayload = getCodebaseDNA(db);
  tasks.push(benchmarkPayload('dna', dnaPayload));

  const contextPayload = buildContext(db, repoDir, query, { maxNodes: 80, maxDepth: 3 });
  tasks.push(benchmarkPayload('context', contextPayload));

  const explorePayload = explore(db, repoDir, query, { maxFiles: 8, maxCharsPerFile: 4000, maxDepth: 2, maxNodes: 80 });
  tasks.push(benchmarkPayload('explore', explorePayload));

  db.close();

  const totalRaw = tasks.reduce((s, r) => s + r.rawBytes, 0);
  const totalCompressed = tasks.reduce((s, r) => s + r.compressedBytes, 0);
  const totalSaved = totalRaw - totalCompressed;
  const avgCompressMs = tasks.reduce((s, r) => s + r.compressMs, 0) / tasks.length;

  console.log('Index:');
  console.log(`  files_scanned=${idx.files_scanned}, files_changed=${idx.files_changed}, duration=${round(indexMs)}ms`);
  console.log('');

  console.log('Per-payload results:');
  console.log('  name       raw         compressed   saved       ratio     compress_ms');
  for (const r of tasks) {
    const line = [
      r.name.padEnd(10),
      humanBytes(r.rawBytes).padEnd(11),
      humanBytes(r.compressedBytes).padEnd(12),
      humanBytes(r.bytesSaved).padEnd(11),
      `${(r.compressionRatio * 100).toFixed(1)}%`.padEnd(9),
      `${round(r.compressMs)}ms`,
    ].join('  ');
    console.log(`  ${line}`);
  }

  console.log('');
  console.log('Summary:');
  console.log(`  total raw:        ${humanBytes(totalRaw)}`);
  console.log(`  total compressed: ${humanBytes(totalCompressed)}`);
  console.log(`  total saved:      ${humanBytes(totalSaved)}`);
  console.log(`  overall ratio:    ${((totalCompressed / Math.max(totalRaw, 1)) * 100).toFixed(1)}%`);
  console.log(`  avg compress ms:  ${round(avgCompressMs)}ms`);
  console.log('');
  console.log('Interpretation:');
  console.log('  lower ratio is better (smaller payload), lower compress_ms is better (lower overhead).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
