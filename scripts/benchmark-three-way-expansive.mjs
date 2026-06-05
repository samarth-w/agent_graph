#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { performance } from 'perf_hooks';

import { indexProject } from '../dist/indexer.js';
import { GraphDB } from '../dist/storage.js';
import { getDbPath } from '../dist/config.js';
import { buildContext } from '../dist/context.js';
import { findCallers, analyzeImpact, getCodebaseDNA } from '../dist/graph.js';
import { SmartCrusher } from '../dist/compression/SmartCrusher.js';
import { CodeCompressor } from '../dist/compression/CodeCompressor.js';

const DEFAULT_COMPRESSION_POLICY = {
  minPayloadBytes: 12 * 1024,
  minCodeChars: 300,
  maxSkeletonizeStrings: 24,
  maxTotalStringChars: 120000,
  contextByteBudgetByGroup: {
    flow: 180000,
    control: 220000,
    unknown: 200000,
  },
};

const RAW_STEP_CACHE = new Map();
const COMPRESSED_STEP_CACHE = new Map();
const HOT_SYMBOL_CACHE = new Map();
let REPO_FILE_COUNT = 200;   // set in main() after listSourceFiles; used for adaptive query budgets
let STRATEGY_ACCUMULATOR = null; // set in main(); accumulates compression stats for online learning

const TASK_TEMPLATES_FLOW = [
  {
    id: 'edit-impact',
    title: 'Edit function then impact-check',
    weight: 0.4,
    group: 'flow',
    query: (symbol, relPath) => `I will modify ${symbol} in ${relPath}. What downstream symbols and files are impacted?`,
  },
  {
    id: 'edit-callers',
    title: 'Edit function then caller-trace',
    weight: 0.35,
    group: 'flow',
    query: (symbol, relPath) => `I changed ${symbol} in ${relPath}. Show caller chains and likely breakpoints.`,
  },
  {
    id: 'edit-context',
    title: 'Edit function then implementation-context',
    weight: 0.25,
    group: 'flow',
    query: (symbol, relPath) => `After editing ${symbol} in ${relPath}, gather context to safely update related code.`,
  },
];

const TASK_TEMPLATES_CONTROL = [
  {
    id: 'control-architecture',
    title: 'Architecture overview around symbol',
    weight: 0.4,
    group: 'control',
    query: (symbol, relPath) => `Explain the module architecture around ${symbol} in ${relPath} and nearby files.`,
  },
  {
    id: 'control-surface',
    title: 'API surface inventory around symbol',
    weight: 0.35,
    group: 'control',
    query: (symbol, relPath) => `List key exported APIs near ${symbol} in ${relPath} and describe responsibilities.`,
  },
  {
    id: 'control-risk',
    title: 'Change risk survey around symbol',
    weight: 0.25,
    group: 'control',
    query: (symbol, relPath) => `If we touch ${symbol} in ${relPath}, summarize risk zones and ownership boundaries.`,
  },
];

const TASK_TEMPLATES_MIXED = [...TASK_TEMPLATES_FLOW, ...TASK_TEMPLATES_CONTROL];

function pickWeightedTemplate(seed, templates) {
  const total = templates.reduce((s, t) => s + t.weight, 0);
  let cursor = ((seed * 1103515245 + 12345) >>> 0) / 0xffffffff;
  cursor *= total;
  for (const t of templates) {
    if (cursor <= t.weight) return t;
    cursor -= t.weight;
  }
  return templates[templates.length - 1];
}

function getTaskTemplates(pack) {
  if (pack === 'flow') return TASK_TEMPLATES_FLOW;
  if (pack === 'control') return TASK_TEMPLATES_CONTROL;
  return TASK_TEMPLATES_MIXED;
}

function hashStringSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function createRng(seedText) {
  let a = hashStringSeed(seedText);
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function ci95(values) {
  if (values.length < 2) return 0;
  return 1.96 * (stddev(values) / Math.sqrt(values.length));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function bootstrapMeanCi95(values, rounds = 1000, rand = Math.random) {
  if (values.length < 2) {
    const m = mean(values);
    return { low: m, high: m, halfWidth: 0 };
  }
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const boot = [];
    for (let i = 0; i < values.length; i++) boot.push(values[Math.floor(rand() * values.length)]);
    samples.push(mean(boot));
  }
  samples.sort((a, b) => a - b);
  const low = quantile(samples, 0.025);
  const high = quantile(samples, 0.975);
  return { low, high, halfWidth: Math.max(0, (high - low) / 2) };
}

function classifyOutliers(values) {
  if (values.length < 4) return { mild: 0, severe: 0, lowFence: 0, highFence: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowMild = q1 - 1.5 * iqr;
  const highMild = q3 + 1.5 * iqr;
  const lowSevere = q1 - 3 * iqr;
  const highSevere = q3 + 3 * iqr;
  let mild = 0;
  let severe = 0;
  for (const v of values) {
    if (v < lowSevere || v > highSevere) severe++;
    else if (v < lowMild || v > highMild) mild++;
  }
  return { mild, severe, lowFence: lowMild, highFence: highMild };
}

function pairedPermutationPValue(a, b, rounds = 5000, rand = Math.random) {
  if (a.length !== b.length || a.length === 0) return { pValue: 1, observedDelta: 0, deltaPct: 0 };
  const diffs = a.map((x, i) => x - b[i]);
  const observed = mean(diffs);
  const absObs = Math.abs(observed);
  let extreme = 0;
  for (let r = 0; r < rounds; r++) {
    let s = 0;
    for (const d of diffs) s += (rand() < 0.5 ? -1 : 1) * d;
    const permMean = s / diffs.length;
    if (Math.abs(permMean) >= absObs) extreme++;
  }
  const pValue = (extreme + 1) / (rounds + 1);
  const bMean = mean(b);
  return {
    pValue,
    observedDelta: observed,
    deltaPct: bMean !== 0 ? (observed / bMean) * 100 : 0,
  };
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function looksLikeCode(str) {
  return str.includes('\n') || str.includes('function') || str.includes('class') || str.includes('=>') || str.includes('{');
}

function applyCodeCompressionSelective(data, mode = 'coding', policy = DEFAULT_COMPRESSION_POLICY, state = null) {
  const st = state || { skeletonized: 0, scannedChars: 0 };
  if (typeof data === 'string') {
    st.scannedChars += data.length;
    const canSkeletonize =
      data.length >= policy.minCodeChars
      && looksLikeCode(data)
      && st.skeletonized < policy.maxSkeletonizeStrings
      && st.scannedChars <= policy.maxTotalStringChars;
    if (canSkeletonize) {
      st.skeletonized += 1;
      return CodeCompressor.skeletonize(data, mode);
    }
    return data;
  }
  if (Array.isArray(data)) return data.map((x) => applyCodeCompressionSelective(x, mode, policy, st));
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = applyCodeCompressionSelective(v, mode, policy, st);
    return out;
  }
  return data;
}

function pruneArrayByBytes(items, perItemFn, byteBudget) {
  if (!Array.isArray(items)) return items;
  const out = [];
  let used = 0;
  for (const item of items) {
    const candidate = perItemFn(item);
    const b = bytesOf(candidate);
    if (used + b > byteBudget) break;
    out.push(candidate);
    used += b;
  }
  return out;
}

// --- Repo-size-aware adaptive query budgets ---
function getRepoBudget(fileCount) {
  if (fileCount <= 120)  return { tier: 'S', depthBonus: -1, nodesMult: 0.55 };
  if (fileCount <= 600)  return { tier: 'M', depthBonus:  0, nodesMult: 1.0  };
  if (fileCount <= 2000) return { tier: 'L', depthBonus:  1, nodesMult: 1.6  };
  return                        { tier: 'XL', depthBonus:  1, nodesMult: 2.2  };
}

// --- CamelCase tokenization for improved smart-search matching ---
function camelCaseTokens(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[_\W]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

const TEST_FILE_RE = /[\\/](?:test|spec|__tests__)[\\/]|\.test\.|\.spec\./i;

// --- Per-file diversity cap: no single file may contribute more than maxFilePct of codeBlocks ---
function applyDiversityCap(codeBlocks, maxFilePct = 0.20) {
  if (!Array.isArray(codeBlocks) || codeBlocks.length === 0) return codeBlocks;
  const total = codeBlocks.length;
  const maxPerFile = Math.max(1, Math.ceil(total * maxFilePct));
  const fileCounts = new Map();
  const out = [];
  for (const block of codeBlocks) {
    const file = block?.file || block?.path || block?.relPath || '';
    const count = fileCounts.get(file) || 0;
    if (count >= maxPerFile) continue;
    fileCounts.set(file, count + 1);
    out.push(block);
  }
  return out;
}

// --- Query confidence signal based on retrieval strategy ---
function computeQueryConfidence(fallbackReason, signal) {
  if (fallbackReason === 'direct_symbol_match' && signal > 0) return 'high';
  if ((fallbackReason === 'camel_token_match' || fallbackReason === 'prefix_symbol_match') && signal > 0) return 'medium';
  return 'low';
}

// --- Lossless-first tabular compaction: schema+rows before lossy crush ---
function tryLosslessCompact(data) {
  if (!data || typeof data !== 'object') return null;
  let totalOrig = 0;
  let totalSaved = 0;
  const out = { ...data };
  for (const [key, val] of Object.entries(data)) {
    if (!Array.isArray(val) || val.length < 4) continue;
    const first = val[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) continue;
    const schema = Object.keys(first);
    if (schema.length < 2 || schema.length > 20) continue;
    const uniform = val.every(
      (item) =>
        typeof item === 'object' && !Array.isArray(item) &&
        Object.keys(item).length === schema.length &&
        schema.every((k) => k in item),
    );
    if (!uniform) continue;
    const origBytes = bytesOf(val);
    const compacted = { _schema: schema, _rows: val.map((item) => schema.map((k) => item[k])) };
    const cmpBytes = bytesOf(compacted);
    if (cmpBytes < origBytes * 0.80) {
      out[key] = compacted;
      totalOrig += origBytes;
      totalSaved += origBytes - cmpBytes;
    }
  }
  if (totalSaved === 0) return null;
  return { data: out, savedPct: totalOrig > 0 ? (totalSaved / totalOrig) * 100 : 0 };
}

// --- Sibling skeletonization: aggressively compress off-spine context blocks ---
function siblingSkeletonize(payload, symbol) {
  if (!payload?.context || !Array.isArray(payload.context.codeBlocks)) return payload;
  const blocks = payload.context.codeBlocks;
  const primaryBlock = blocks.find((b) => (b?.symbols || []).includes(symbol) || b?.name === symbol);
  const primaryPath = primaryBlock?.file || primaryBlock?.path || '';
  const out = { ...payload, context: { ...payload.context } };
  out.context.codeBlocks = blocks.map((block) => {
    const bPath = block?.file || block?.path || '';
    const isSpine = bPath === primaryPath || (block?.symbols || []).includes(symbol);
    if (isSpine || !block?.code || typeof block.code !== 'string' || block.code.length < 200) return block;
    return { ...block, code: CodeCompressor.skeletonize(block.code, 'coding') };
  });
  return out;
}

// --- Per-run compression strategy accumulator (lightweight adaptive learning) ---
class StrategyAccumulator {
  constructor() {
    this._records = [];
  }
  record(taskGroup, rawBytes, cmpBytes, rawMs, cmpMs, compressionKind) {
    this._records.push({ taskGroup, rawBytes, cmpBytes, rawMs, cmpMs, compressionKind });
  }
  applyLearning(policy) {
    const relevant = this._records.filter((r) => r.compressionKind === 'lossy_crusher');
    if (relevant.length < 10) return policy;
    const avgSavings = mean(relevant.map((r) => (r.rawBytes > 0 ? (r.rawBytes - r.cmpBytes) / r.rawBytes : 0)));
    const avgOverhead = mean(relevant.map((r) => (r.rawMs > 0 ? (r.cmpMs - r.rawMs) / r.rawMs : 0)));
    let minPayload = policy.minPayloadBytes;
    if (avgSavings < 0.12) minPayload = Math.min(32768, Math.round(minPayload * 1.25));
    else if (avgSavings > 0.35 && avgOverhead < 0.25) minPayload = Math.max(4096, Math.round(minPayload * 0.80));
    return { ...policy, minPayloadBytes: minPayload };
  }
  reset() { this._records = []; }
}

function budgetContextPayload(context, byteBudget) {
  if (!context || typeof context !== 'object') return context;
  const out = { ...context };
  if (Array.isArray(out.codeBlocks)) {
    out.codeBlocks = applyDiversityCap(out.codeBlocks, 0.20);
    out.codeBlocks = pruneArrayByBytes(out.codeBlocks, (x) => x, Math.max(2048, Math.floor(byteBudget * 0.7)));
  }
  if (Array.isArray(out.relatedFiles)) {
    out.relatedFiles = pruneArrayByBytes(out.relatedFiles, (x) => x, Math.max(1024, Math.floor(byteBudget * 0.2)));
  }
  if (Array.isArray(out.entryPoints)) {
    out.entryPoints = pruneArrayByBytes(out.entryPoints, (x) => x, Math.max(512, Math.floor(byteBudget * 0.1)));
  }
  return out;
}

function generateScenarios(db, tasksPerMode, taskPack) {
  const nodes = db.getAllNodes();
  const scenarios = [];
  if (nodes.length === 0) return scenarios;
  const templates = getTaskTemplates(taskPack);

  const stride = Math.max(1, Math.floor(nodes.length / tasksPerMode));
  for (let i = 0; i < nodes.length && scenarios.length < tasksPerMode; i += stride) {
    const node = nodes[i];
    const fileRec = db.getFileById(node.file_id);
    const relPath = fileRec?.path || '';
    const task = pickWeightedTemplate(i + scenarios.length, templates);
    scenarios.push({
      symbol: node.name,
      relPath,
      taskId: task.id,
      taskTitle: task.title,
      taskGroup: task.group,
      query: task.query(node.name, relPath || 'unknown file'),
    });
  }

  // Backfill if stride underfilled due to small node count.
  let cursor = 0;
  while (scenarios.length < tasksPerMode && cursor < nodes.length * 2) {
    const node = nodes[cursor % nodes.length];
    const fileRec = db.getFileById(node.file_id);
    const relPath = fileRec?.path || '';
    const task = pickWeightedTemplate(cursor + scenarios.length, templates);
    scenarios.push({
      symbol: node.name,
      relPath,
      taskId: task.id,
      taskTitle: task.title,
      taskGroup: task.group,
      query: task.query(node.name, relPath || 'unknown file'),
    });
    cursor++;
  }

  return scenarios;
}

function runWithoutCgraphStep(files, symbol, query) {
  let fileReads = 0;
  let bytesRead = 0;

  const safeSymbol = escapeRegExp(symbol);
  const callPattern = new RegExp(`\\b${safeSymbol}\\s*\\(`, 'g');
  const refPattern = new RegExp(`\\b${safeSymbol}\\b`, 'g');
  const importRe = /\bimport\b/g;
  const exportRe = /\bexport\b/g;

  const t0 = performance.now();
  let callers = 0;
  let refs = 0;
  let imports = 0;
  let exports = 0;

  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    fileReads++;
    bytesRead += Buffer.byteLength(txt, 'utf8');
    callers += (txt.match(callPattern) || []).length;
    refs += (txt.match(refPattern) || []).length;
    imports += (txt.match(importRe) || []).length;
    exports += (txt.match(exportRe) || []).length;
  }

  const payload = { symbol, query, callers, refs, imports, exports, scanned: files.length };
  const t1 = performance.now();
  return {
    ms: t1 - t0,
    outBytes: bytesOf(payload),
    fileReads,
    bytesRead,
    signal: callers + refs,
    fallbackReason: 'naive_full_scan',
  };
}

function buildSmartSearchIndex(files) {
  const symbolToFiles = new Map();
  const fileSizes = new Map();
  const identifierRe = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    fileSizes.set(f, Buffer.byteLength(txt, 'utf8'));
    const uniq = new Set(txt.match(identifierRe) || []);
    for (const ident of uniq) {
      const bucket = symbolToFiles.get(ident);
      if (bucket) bucket.push(f);
      else symbolToFiles.set(ident, [f]);
    }
  }

  return { files, symbolToFiles, fileSizes };
}

function selectCandidateFiles(index, symbol) {
  const direct = index.symbolToFiles.get(symbol);
  if (direct && direct.length) {
    // Deprioritize test files: sort them to the back
    const sorted = [...direct].sort((a, b) => (TEST_FILE_RE.test(a) ? 1 : 0) - (TEST_FILE_RE.test(b) ? 1 : 0));
    return { files: sorted, reason: 'direct_symbol_match' };
  }
  // CamelCase token scoring: score files by how many camel-split tokens match
  const tokens = camelCaseTokens(symbol).filter((t) => t.length >= 3);
  if (tokens.length > 1) {
    const fileScore = new Map();
    for (const token of tokens) {
      for (const [ident, fileList] of index.symbolToFiles.entries()) {
        if (ident.toLowerCase().includes(token)) {
          for (const f of fileList) fileScore.set(f, (fileScore.get(f) || 0) + 1);
        }
      }
    }
    if (fileScore.size) {
      const topFiles = [...fileScore.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([f]) => f)
        .sort((a, b) => (TEST_FILE_RE.test(a) ? 1 : 0) - (TEST_FILE_RE.test(b) ? 1 : 0));
      return { files: topFiles, reason: 'camel_token_match' };
    }
  }
  const byPrefix = [];
  for (const [ident, fileList] of index.symbolToFiles.entries()) {
    if (ident.startsWith(symbol.slice(0, 4))) {
      byPrefix.push(...fileList);
      if (byPrefix.length >= 80) break;
    }
  }
  if (byPrefix.length) return { files: [...new Set(byPrefix)], reason: 'prefix_symbol_match' };
  return { files: index.files.slice(0, Math.min(20, index.files.length)), reason: 'fallback_head_files' };
}

function runWithoutCgraphSmartStep(index, symbol, query) {
  const picked = selectCandidateFiles(index, symbol);
  const candidates = picked.files;
  let fileReads = 0;
  let bytesRead = 0;

  const safeSymbol = escapeRegExp(symbol);
  const callPattern = new RegExp(`\\b${safeSymbol}\\s*\\(`, 'g');
  const refPattern = new RegExp(`\\b${safeSymbol}\\b`, 'g');
  const importRe = /\bimport\b/g;
  const exportRe = /\bexport\b/g;

  const t0 = performance.now();
  let callers = 0;
  let refs = 0;
  let imports = 0;
  let exports = 0;

  for (const f of candidates) {
    const txt = fs.readFileSync(f, 'utf8');
    fileReads++;
    bytesRead += index.fileSizes.get(f) || Buffer.byteLength(txt, 'utf8');
    callers += (txt.match(callPattern) || []).length;
    refs += (txt.match(refPattern) || []).length;
    imports += (txt.match(importRe) || []).length;
    exports += (txt.match(exportRe) || []).length;
  }

  const payload = { symbol, query, callers, refs, imports, exports, scanned: candidates.length, strategy: 'smart-search' };
  const t1 = performance.now();
  return {
    ms: t1 - t0,
    outBytes: bytesOf(payload),
    fileReads,
    bytesRead,
    signal: callers + refs,
    fallbackReason: picked.reason,
    queryConfidence: computeQueryConfidence(picked.reason, callers + refs),
  };
}

function countAny(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.nodes)) return value.nodes.length;
    if (Array.isArray(value.items)) return value.items.length;
    if (Array.isArray(value.symbols)) return value.symbols.length;
    return Object.keys(value).length;
  }
  if (typeof value === 'number') return value;
  return value ? 1 : 0;
}

function getQueryProfile(taskGroup, fileCount = 200) {
  const { tier, depthBonus, nodesMult } = getRepoBudget(fileCount);
  const ds = (d) => Math.min(5, Math.max(1, d + depthBonus));
  const ns = (n) => Math.round(n * nodesMult);
  if (taskGroup === 'flow')    return { callersDepth: ds(3), callersNodes: ns(140), impactDepth: ds(3), impactNodes: ns(220), contextNodes: ns(90),  contextDepth: ds(3), tier };
  if (taskGroup === 'control') return { callersDepth: ds(2), callersNodes: ns(80),  impactDepth: ds(2), impactNodes: ns(120), contextNodes: ns(55),  contextDepth: ds(2), tier };
  return                              { callersDepth: ds(3), callersNodes: ns(120), impactDepth: ds(3), impactNodes: ns(200), contextNodes: ns(80),  contextDepth: ds(3), tier };
}

function makeRawCacheKey(symbol, query, taskGroup) {
  return `${taskGroup || 'unknown'}::${symbol}::${query}`;
}

function precomputeHotSymbols(db, repoDir, scenarios, policy) {
  HOT_SYMBOL_CACHE.clear();
  const counts = new Map();
  for (const sc of scenarios) counts.set(sc.symbol, (counts.get(sc.symbol) || 0) + 1);
  const hot = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([sym]) => sym);
  for (const symbol of hot) {
    const sc = scenarios.find((x) => x.symbol === symbol);
    if (!sc) continue;
    const raw = runCgraphRawStep(db, repoDir, symbol, sc.query, sc.taskGroup, policy, false);
    HOT_SYMBOL_CACHE.set(symbol, raw);
  }
}

function runCgraphRawStep(db, repoDir, symbol, query, taskGroup = 'unknown', policy = DEFAULT_COMPRESSION_POLICY, useCache = true) {
  const cacheKey = makeRawCacheKey(symbol, query, taskGroup);
  if (useCache && RAW_STEP_CACHE.has(cacheKey)) return RAW_STEP_CACHE.get(cacheKey);
  if (useCache && HOT_SYMBOL_CACHE.has(symbol)) {
    const hot = HOT_SYMBOL_CACHE.get(symbol);
    RAW_STEP_CACHE.set(cacheKey, hot);
    return hot;
  }

  const profile = getQueryProfile(taskGroup, REPO_FILE_COUNT);
  const byteBudget = policy.contextByteBudgetByGroup?.[taskGroup] || policy.contextByteBudgetByGroup?.unknown || 200000;
  const t0 = performance.now();
  const callers = findCallers(db, symbol, { maxDepth: profile.callersDepth, maxNodes: profile.callersNodes });
  const impact = analyzeImpact(db, symbol, { maxDepth: profile.impactDepth, maxNodes: profile.impactNodes });
  const contextRaw = buildContext(db, repoDir, query, { maxNodes: profile.contextNodes, maxDepth: profile.contextDepth });
  const context = budgetContextPayload(contextRaw, byteBudget);
  const dna = getCodebaseDNA(db);
  const payload = { callers, impact, context, dna };
  const t1 = performance.now();

  const result = {
    ms: t1 - t0,
    outBytes: bytesOf(payload),
    fileReads: 0,
    bytesRead: 0,
    signal: countAny(callers) + countAny(impact) + countAny(context),
    fallbackReason: 'none_graph_primary',
    queryConfidence: (countAny(callers) + countAny(impact)) > 0 ? 'high' : 'low',
    blastRadius: countAny(impact),
    repoBudgetTier: profile.tier,
    payload,
  };
  if (useCache) RAW_STEP_CACHE.set(cacheKey, result);
  return result;
}

function makeCompressedCacheKey(symbol, query, taskGroup, policy) {
  return `${makeRawCacheKey(symbol, query, taskGroup)}::${policy.minPayloadBytes}:${policy.minCodeChars}:${policy.maxSkeletonizeStrings}:${policy.maxTotalStringChars}`;
}

function runCgraphCompressedEndToEndStep(db, repoDir, symbol, query, taskGroup = 'unknown', policy = DEFAULT_COMPRESSION_POLICY, useMemoization = true) {
  const cKey = makeCompressedCacheKey(symbol, query, taskGroup, policy);
  if (useMemoization && COMPRESSED_STEP_CACHE.has(cKey)) return COMPRESSED_STEP_CACHE.get(cKey);

  const raw = runCgraphRawStep(db, repoDir, symbol, query, taskGroup, policy, true);

  if (raw.outBytes < policy.minPayloadBytes) {
    const passthrough = {
      ms: raw.ms,
      outBytes: raw.outBytes,
      fileReads: 0,
      bytesRead: 0,
      signal: raw.signal,
      fallbackReason: 'compression_skipped_small_payload',
      compressionKind: 'skipped_small_payload',
      queryConfidence: raw.queryConfidence,
      blastRadius: raw.blastRadius,
      repoBudgetTier: raw.repoBudgetTier,
    };
    if (useMemoization) COMPRESSED_STEP_CACHE.set(cKey, passthrough);
    return passthrough;
  }

  const t0 = performance.now();
  // Lossless-first: try tabular compaction before lossy crushing
  const losslessResult = tryLosslessCompact(raw.payload);
  const sourcePayload = (losslessResult && losslessResult.savedPct >= 25) ? losslessResult.data : raw.payload;
  const compressionKind = (losslessResult && losslessResult.savedPct >= 25) ? 'lossless_tabular' : 'lossy_crusher';
  // Sibling skeletonization: aggressively compress off-spine context blocks
  const skelPayload = siblingSkeletonize(sourcePayload, symbol);
  const crushed = SmartCrusher.crush(skelPayload, 'coding', 'standard');
  const compressed = applyCodeCompressionSelective(crushed, 'coding', policy);
  const t1 = performance.now();
  const cmpBytes = bytesOf(compressed);
  if (STRATEGY_ACCUMULATOR) {
    STRATEGY_ACCUMULATOR.record(taskGroup, raw.outBytes, cmpBytes, raw.ms, raw.ms + (t1 - t0), compressionKind);
  }
  const result = {
    ms: raw.ms + (t1 - t0),
    outBytes: cmpBytes,
    fileReads: 0,
    bytesRead: 0,
    signal: raw.signal,
    fallbackReason: 'none_graph_primary',
    compressionKind,
    queryConfidence: raw.queryConfidence,
    blastRadius: raw.blastRadius,
    repoBudgetTier: raw.repoBudgetTier,
  };
  if (useMemoization) COMPRESSED_STEP_CACHE.set(cKey, result);
  return result;
}

function summarize(label, rows) {
  const msSorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const totalMs = rows.reduce((s, r) => s + r.ms, 0);
  const totalOut = rows.reduce((s, r) => s + r.outBytes, 0);
  const totalReads = rows.reduce((s, r) => s + r.fileReads, 0);
  const totalReadBytes = rows.reduce((s, r) => s + r.bytesRead, 0);
  const signalHitRate = rows.length ? rows.filter((r) => (r.signal || 0) > 0).length / rows.length : 0;
  const avgSignal = rows.length ? rows.reduce((s, r) => s + (r.signal || 0), 0) / rows.length : 0;
  const taskBreakdown = {};
  const taskGroupBreakdown = {};
  const fallbackReasonCounts = {};
  const compressionKindCounts = {};
  const queryConfidenceCounts = {};
  let blastRadiusSum = 0;
  let blastRadiusCount = 0;
  for (const r of rows) {
    const key = r.taskId || 'unknown';
    if (!taskBreakdown[key]) {
      taskBreakdown[key] = { taskId: key, taskTitle: r.taskTitle || key, count: 0, totalMs: 0, totalOut: 0, signalHits: 0 };
    }
    const b = taskBreakdown[key];
    b.count += 1;
    b.totalMs += r.ms;
    b.totalOut += r.outBytes;
    if ((r.signal || 0) > 0) b.signalHits += 1;

    const gKey = r.taskGroup || 'unknown';
    if (!taskGroupBreakdown[gKey]) {
      taskGroupBreakdown[gKey] = { group: gKey, count: 0, totalMs: 0, totalOut: 0, signalHits: 0 };
    }
    const g = taskGroupBreakdown[gKey];
    g.count += 1;
    g.totalMs += r.ms;
    g.totalOut += r.outBytes;
    if ((r.signal || 0) > 0) g.signalHits += 1;

    const reason = r.fallbackReason || 'unspecified';
    fallbackReasonCounts[reason] = (fallbackReasonCounts[reason] || 0) + 1;
    if (r.compressionKind) compressionKindCounts[r.compressionKind] = (compressionKindCounts[r.compressionKind] || 0) + 1;
    if (r.queryConfidence) queryConfidenceCounts[r.queryConfidence] = (queryConfidenceCounts[r.queryConfidence] || 0) + 1;
    if (r.blastRadius != null) { blastRadiusSum += r.blastRadius; blastRadiusCount++; }
  }
  for (const b of Object.values(taskBreakdown)) {
    b.avgMs = b.count > 0 ? b.totalMs / b.count : 0;
    b.avgOut = b.count > 0 ? b.totalOut / b.count : 0;
    b.signalHitRate = b.count > 0 ? b.signalHits / b.count : 0;
  }
  for (const g of Object.values(taskGroupBreakdown)) {
    g.avgMs = g.count > 0 ? g.totalMs / g.count : 0;
    g.avgOut = g.count > 0 ? g.totalOut / g.count : 0;
    g.signalHitRate = g.count > 0 ? g.signalHits / g.count : 0;
  }
  return {
    label,
    steps: rows.length,
    totalMs,
    avgMs: rows.length ? totalMs / rows.length : 0,
    p50Ms: pct(msSorted, 0.5),
    p95Ms: pct(msSorted, 0.95),
    totalOut,
    avgOut: rows.length ? totalOut / rows.length : 0,
    totalReads,
    totalReadBytes,
    signalHitRate,
    avgSignal,
    taskBreakdown,
    taskGroupBreakdown,
    fallbackReasonCounts,
    compressionKindCounts,
    queryConfidenceCounts,
    avgBlastRadius: blastRadiusCount > 0 ? blastRadiusSum / blastRadiusCount : 0,
    repoBudgetTier: rows[0]?.repoBudgetTier || 'M',
  };
}

function extendToLength(baseScenarios, targetCount) {
  const out = [];
  if (baseScenarios.length === 0) return out;
  for (let i = 0; i < targetCount; i++) out.push(baseScenarios[i % baseScenarios.length]);
  return out;
}

function runScenarioLoopForCount(scenarios, taskCount, runner) {
  const rows = [];
  if (scenarios.length === 0) return rows;

  for (let i = 0; i < taskCount; i++) {
    rows.push(runner(scenarios[i % scenarios.length], i));
  }
  return rows;
}

function applyBenchEdit(repoDir, relPath, symbol, taskIndex, taskId) {
  if (!relPath) return null;
  const absPath = path.join(repoDir, relPath);
  if (!fs.existsSync(absPath)) return null;
  const src = fs.readFileSync(absPath, 'utf8');
  const safeSymbol = escapeRegExp(symbol);
  const signatureRe = new RegExp(`(function\\s+${safeSymbol}\\b[^\\n]*\\{)`);
  const callRe = new RegExp(`\\b${safeSymbol}\\s*\\(`);
  const firstUseRe = new RegExp(`\\b${safeSymbol}\\b`);
  const lines = src.split(/\r?\n/);

  let mutated = src;
  const marker = `// bench-edit ${taskIndex} ${symbol}`;

  if (taskId === 'edit-impact') {
    if (signatureRe.test(mutated)) {
      mutated = mutated.replace(signatureRe, `$1\n  void 0; ${marker}`);
    }
  } else if (taskId === 'edit-callers') {
    if (callRe.test(mutated)) {
      mutated = mutated.replace(callRe, `${symbol}(/* bench-callers */ `);
    }
  } else if (taskId === 'edit-context') {
    const hit = lines.findIndex((ln) => ln.includes(symbol));
    if (hit >= 0) {
      lines.splice(hit, 0, `/* bench-context ${taskIndex}: ${symbol} */`);
      mutated = lines.join('\n');
    }
  }

  if (mutated === src && firstUseRe.test(mutated)) mutated = mutated.replace(firstUseRe, `${symbol}_benchTmp`);
  if (mutated === src) mutated = `${src}\n${marker}\n`;
  fs.writeFileSync(absPath, mutated, 'utf8');
  return relPath;
}

function revertBenchEdit(repoDir, relPath) {
  if (!relPath) return;
  const out = spawnSync('git', ['-C', repoDir, 'checkout', '--', relPath], { encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`Failed to revert edited file ${relPath}: ${(out.stderr || out.stdout || '').trim()}`);
  }
}

function runWithOptionalEdit(repoDir, scenario, taskIndex, enableEdits, runner) {
  let editedPath = null;
  if (enableEdits) editedPath = applyBenchEdit(repoDir, scenario.relPath, scenario.symbol, taskIndex, scenario.taskId);
  try {
    const result = runner();
    return {
      ...result,
      taskId: scenario.taskId || 'unknown',
      taskTitle: scenario.taskTitle || 'unknown',
      taskGroup: scenario.taskGroup || 'unknown',
    };
  } finally {
    if (editedPath) revertBenchEdit(repoDir, editedPath);
  }
}

function gitIsClean(repoDir) {
  const res = spawnSync('git', ['-C', repoDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return res.status === 0 && (res.stdout || '').trim() === '';
}

function printSummaryRow(s) {
  const cols = [
    s.label.padEnd(20),
    String(s.steps).padStart(5),
    `${Math.round(s.totalMs)} ms`.padStart(11),
    `${s.avgMs.toFixed(2)} ms`.padStart(11),
    `${s.p50Ms.toFixed(2)} ms`.padStart(11),
    `${s.p95Ms.toFixed(2)} ms`.padStart(11),
    humanBytes(s.totalOut).padStart(12),
    String(s.totalReads).padStart(10),
    humanBytes(s.totalReadBytes).padStart(12),
  ];
  console.log(cols.join('  '));
}

function rotateScenarios(scenarios, offset) {
  if (scenarios.length === 0) return scenarios;
  const n = scenarios.length;
  const k = ((offset % n) + n) % n;
  if (k === 0) return scenarios;
  return scenarios.slice(k).concat(scenarios.slice(0, k));
}

function rotateModes(modes, offset) {
  return rotateScenarios(modes, offset);
}

function aggregateMode(label, summaries, rand = Math.random) {
  const totalMsArr = summaries.map((s) => s.totalMs);
  const avgMsArr = summaries.map((s) => s.avgMs);
  const p50Arr = summaries.map((s) => s.p50Ms);
  const p95Arr = summaries.map((s) => s.p95Ms);
  const avgOutArr = summaries.map((s) => s.avgOut);
  const totalOutArr = summaries.map((s) => s.totalOut);
  const tpsArr = summaries.map((s) => (s.totalMs > 0 ? (s.steps * 1000) / s.totalMs : 0));
  const signalHitArr = summaries.map((s) => s.signalHitRate);
  const avgSignalArr = summaries.map((s) => s.avgSignal);
  const avgMsBoot = bootstrapMeanCi95(avgMsArr, 1000, rand);
  const tpsBoot = bootstrapMeanCi95(tpsArr, 1000, rand);
  const outliers = classifyOutliers(avgMsArr);
  const taskKeys = new Set();
  for (const s of summaries) {
    for (const key of Object.keys(s.taskBreakdown || {})) taskKeys.add(key);
  }
  const taskBreakdown = {};
  for (const key of taskKeys) {
    const rows = summaries.map((s) => s.taskBreakdown?.[key]).filter(Boolean);
    if (!rows.length) continue;
    taskBreakdown[key] = {
      taskId: key,
      taskTitle: rows[0].taskTitle,
      countMean: mean(rows.map((r) => r.count)),
      avgMsMean: mean(rows.map((r) => r.avgMs)),
      avgMsCi95: ci95(rows.map((r) => r.avgMs)),
      avgOutMean: mean(rows.map((r) => r.avgOut)),
      signalHitRateMean: mean(rows.map((r) => r.signalHitRate)),
    };
  }

  const taskGroups = new Set();
  for (const s of summaries) {
    for (const key of Object.keys(s.taskGroupBreakdown || {})) taskGroups.add(key);
  }
  const taskGroupBreakdown = {};
  for (const key of taskGroups) {
    const rows = summaries.map((s) => s.taskGroupBreakdown?.[key]).filter(Boolean);
    if (!rows.length) continue;
    taskGroupBreakdown[key] = {
      group: key,
      countMean: mean(rows.map((r) => r.count)),
      avgMsMean: mean(rows.map((r) => r.avgMs)),
      avgMsCi95: ci95(rows.map((r) => r.avgMs)),
      avgOutMean: mean(rows.map((r) => r.avgOut)),
      signalHitRateMean: mean(rows.map((r) => r.signalHitRate)),
    };
  }

  const fallbackReasonCounts = {};
  for (const s of summaries) {
    for (const [k, v] of Object.entries(s.fallbackReasonCounts || {})) {
      fallbackReasonCounts[k] = (fallbackReasonCounts[k] || 0) + v;
    }
  }
  for (const k of Object.keys(fallbackReasonCounts)) {
    fallbackReasonCounts[k] = fallbackReasonCounts[k] / Math.max(1, summaries.length);
  }
  const compressionKindCounts = {};
  const queryConfidenceCounts = {};
  for (const s of summaries) {
    for (const [k, v] of Object.entries(s.compressionKindCounts || {})) compressionKindCounts[k] = (compressionKindCounts[k] || 0) + v;
    for (const [k, v] of Object.entries(s.queryConfidenceCounts || {})) queryConfidenceCounts[k] = (queryConfidenceCounts[k] || 0) + v;
  }
  for (const k of Object.keys(compressionKindCounts)) compressionKindCounts[k] /= Math.max(1, summaries.length);
  for (const k of Object.keys(queryConfidenceCounts)) queryConfidenceCounts[k] /= Math.max(1, summaries.length);
  const avgBlastRadius = mean(summaries.map((s) => s.avgBlastRadius || 0));

  return {
    label,
    runs: summaries.length,
    stepsPerRun: summaries[0]?.steps || 0,
    totalMsMean: mean(totalMsArr),
    totalMsCi95: ci95(totalMsArr),
    avgMsMean: mean(avgMsArr),
    avgMsCi95: ci95(avgMsArr),
    avgMsBootCi95: avgMsBoot,
    p50MsMean: mean(p50Arr),
    p95MsMean: mean(p95Arr),
    avgOutMean: mean(avgOutArr),
    totalOutMean: mean(totalOutArr),
    throughputMean: mean(tpsArr),
    throughputCi95: ci95(tpsArr),
    throughputBootCi95: tpsBoot,
    totalReadsMean: mean(summaries.map((s) => s.totalReads)),
    totalReadBytesMean: mean(summaries.map((s) => s.totalReadBytes)),
    signalHitRateMean: mean(signalHitArr),
    avgSignalMean: mean(avgSignalArr),
    outliers,
    taskBreakdown,
    taskGroupBreakdown,
    fallbackReasonCounts,
    compressionKindCounts,
    queryConfidenceCounts,
    avgBlastRadius,
    repoBudgetTier: summaries[0]?.repoBudgetTier || 'M',
  };
}

function printAggregateRow(a) {
  const cols = [
    a.label.padEnd(20),
    String(a.runs).padStart(4),
    `${a.avgMsMean.toFixed(2)}±${a.avgMsBootCi95.halfWidth.toFixed(2)}`.padStart(15),
    `${a.p50MsMean.toFixed(2)}`.padStart(9),
    `${a.p95MsMean.toFixed(2)}`.padStart(9),
    `${a.throughputMean.toFixed(2)}±${a.throughputBootCi95.halfWidth.toFixed(2)}`.padStart(18),
    humanBytes(a.avgOutMean).padStart(10),
  ];
  console.log(cols.join('  '));
}

function printTaskBreakdown(label, breakdown) {
  const keys = Object.keys(breakdown || {}).sort();
  if (!keys.length) return;
  console.log(`task_breakdown: ${label}`);
  for (const key of keys) {
    const b = breakdown[key];
    console.log(
      `  - ${key}: avg_ms=${b.avgMsMean.toFixed(2)}±${b.avgMsCi95.toFixed(2)} avg_out=${humanBytes(b.avgOutMean)} signal_hit=${(b.signalHitRateMean * 100).toFixed(1)}%`,
    );
  }
}

function printTaskGroupBreakdown(label, breakdown) {
  const keys = Object.keys(breakdown || {}).sort();
  if (!keys.length) return;
  console.log(`task_group_split: ${label}`);
  for (const key of keys) {
    const b = breakdown[key];
    console.log(
      `  - ${key}: avg_ms=${b.avgMsMean.toFixed(2)}±${b.avgMsCi95.toFixed(2)} avg_out=${humanBytes(b.avgOutMean)} signal_hit=${(b.signalHitRateMean * 100).toFixed(1)}%`,
    );
  }
}

function formatFallbackReasonCounts(counts) {
  const parts = [];
  for (const [k, v] of Object.entries(counts || {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`${k}:${Number(v).toFixed(2)}`);
  }
  return parts.join('|');
}

function formatSigResult(label, result, noiseThresholdPct = 1) {
  const noisy = Math.abs(result.deltaPct) < noiseThresholdPct;
  const sig = result.pValue < 0.05;
  return `${label}: delta=${result.deltaPct.toFixed(2)}% p=${result.pValue.toFixed(4)} ${sig ? '(significant)' : '(not-significant)'} ${noisy ? '[within-noise]' : ''}`;
}

function resetStepCaches() {
  RAW_STEP_CACHE.clear();
  COMPRESSED_STEP_CACHE.clear();
  HOT_SYMBOL_CACHE.clear();
}

function evaluateCompressionPolicy(db, repoDir, scenarios, policy, sampleSize = 20) {
  const sample = scenarios.slice(0, Math.min(sampleSize, scenarios.length));
  if (!sample.length) {
    return { avgRawMs: 0, avgCmpMs: 0, savingsPct: 0, overheadPct: 0 };
  }
  let rawMs = 0;
  let cmpMs = 0;
  let rawBytes = 0;
  let cmpBytes = 0;
  for (const sc of sample) {
    const raw = runCgraphRawStep(db, repoDir, sc.symbol, sc.query, sc.taskGroup, policy, false);
    rawMs += raw.ms;
    rawBytes += raw.outBytes;
    if (raw.outBytes < policy.minPayloadBytes) {
      cmpMs += raw.ms;
      cmpBytes += raw.outBytes;
      continue;
    }
    const t0 = performance.now();
    const crushed = SmartCrusher.crush(raw.payload, 'coding', 'standard');
    const compressed = applyCodeCompressionSelective(crushed, 'coding', policy);
    const t1 = performance.now();
    cmpMs += raw.ms + (t1 - t0);
    cmpBytes += bytesOf(compressed);
  }
  const avgRawMs = rawMs / sample.length;
  const avgCmpMs = cmpMs / sample.length;
  const savingsPct = rawBytes > 0 ? ((rawBytes - cmpBytes) / rawBytes) * 100 : 0;
  const overheadPct = avgRawMs > 0 ? ((avgCmpMs - avgRawMs) / avgRawMs) * 100 : 0;
  return { avgRawMs, avgCmpMs, savingsPct, overheadPct };
}

function tuneCompressionPolicy(db, repoDir, scenarios, minCompressionPct, maxOverheadPct) {
  const candidates = [
    { ...DEFAULT_COMPRESSION_POLICY, minPayloadBytes: 8 * 1024, maxSkeletonizeStrings: 20, maxTotalStringChars: 90000 },
    { ...DEFAULT_COMPRESSION_POLICY, minPayloadBytes: 12 * 1024, maxSkeletonizeStrings: 24, maxTotalStringChars: 120000 },
    { ...DEFAULT_COMPRESSION_POLICY, minPayloadBytes: 20 * 1024, maxSkeletonizeStrings: 16, maxTotalStringChars: 70000 },
    { ...DEFAULT_COMPRESSION_POLICY, minPayloadBytes: 28 * 1024, maxSkeletonizeStrings: 12, maxTotalStringChars: 50000 },
  ];

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  let bestEval = null;
  for (const policy of candidates) {
    const e = evaluateCompressionPolicy(db, repoDir, scenarios, policy, 24);
    const meets = e.savingsPct >= minCompressionPct && e.overheadPct <= maxOverheadPct;
    const penalty = meets ? 0 : 500;
    const score = e.avgCmpMs + penalty - Math.min(e.savingsPct, 100) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = policy;
      bestEval = e;
    }
  }
  return { policy: best, eval: bestEval };
}

function writeCsvReport(csvPath, perRun, aggMap) {
  const lines = [];
  lines.push('type,run,mode,steps,total_ms,avg_ms,p50_ms,p95_ms,total_out_bytes,file_reads,bytes_read,signal_hit_rate,avg_signal,fallback_reasons,compression_kinds,query_confidence,avg_blast_radius,repo_budget_tier');
  for (const row of perRun) {
    for (const mode of ['without_cgraph', 'without_cgraph_smart', 'cgraph_raw', 'cgraph_compressed']) {
      const s = row[mode];
      lines.push([
        'run',
        row.run,
        mode,
        s.steps,
        s.totalMs.toFixed(4),
        s.avgMs.toFixed(4),
        s.p50Ms.toFixed(4),
        s.p95Ms.toFixed(4),
        s.totalOut,
        s.totalReads,
        s.totalReadBytes,
        s.signalHitRate.toFixed(6),
        s.avgSignal.toFixed(6),
        `"${formatFallbackReasonCounts(s.fallbackReasonCounts)}"`,
        `"${formatFallbackReasonCounts(s.compressionKindCounts)}"`,
        `"${formatFallbackReasonCounts(s.queryConfidenceCounts)}"`,
        s.avgBlastRadius != null ? s.avgBlastRadius.toFixed(2) : '0.00',
        s.repoBudgetTier || 'M',
      ].join(','));
    }
  }
  for (const [mode, a] of Object.entries(aggMap)) {
    lines.push([
      'aggregate',
      '',
      mode,
      a.stepsPerRun,
      a.totalMsMean.toFixed(4),
      a.avgMsMean.toFixed(4),
      a.p50MsMean.toFixed(4),
      a.p95MsMean.toFixed(4),
      a.totalOutMean.toFixed(4),
      a.totalReadsMean.toFixed(4),
      a.totalReadBytesMean.toFixed(4),
      a.signalHitRateMean.toFixed(6),
      a.avgSignalMean.toFixed(6),
      `"${formatFallbackReasonCounts(a.fallbackReasonCounts)}"`,
      `"${formatFallbackReasonCounts(a.compressionKindCounts)}"`,
      `"${formatFallbackReasonCounts(a.queryConfidenceCounts)}"`,
      a.avgBlastRadius != null ? a.avgBlastRadius.toFixed(2) : '0.00',
      a.repoBudgetTier || 'M',
    ].join(','));
  }
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const repoUrl = process.argv[2] || 'https://github.com/expressjs/express.git';
  const taskCountArg = process.argv[3] || '1000';
  const editsArg = (process.argv[4] || 'true').toLowerCase();
  const repeatsArg = process.argv[5] || '5';
  const jsonOutArg = process.argv[6] || path.join('.bench', 'results', `task-bound-${repoNameFromUrl(repoUrl)}.json`);
  const csvOutArg = process.argv[7] || jsonOutArg.replace(/\.json$/i, '.csv');
  const profileArg = (process.argv[8] || 'warm').toLowerCase();
  const burnInArg = process.argv[9] || '20';
  const seedArg = process.argv[10] || 'bench-seed';
  const noiseThresholdArg = process.argv[11] || '1';
  const minCompressionArg = process.argv[12] || '20';
  const maxCompressedOverheadArg = process.argv[13] || '25';
  const minRawSignalArg = process.argv[14] || '0.99';
  const enforceGatesArg = (process.argv[15] || 'false').toLowerCase();
  const taskPackArg = (process.argv[16] || 'mixed').toLowerCase();
  const useMemoArg = (process.argv[17] || 'true').toLowerCase();
  const useOptimizerArg = (process.argv[18] || 'true').toLowerCase();
  const enableEdits = editsArg !== 'false';

  let requestedTasks = Number(taskCountArg);
  if (!Number.isFinite(requestedTasks)) requestedTasks = 1000;
  const clampedTasks = Math.min(100000, Math.max(100, requestedTasks));
  let tasksPerMode = clampedTasks;
  let repeats = Number(repeatsArg);
  if (!Number.isFinite(repeats)) repeats = 5;
  repeats = Math.min(30, Math.max(1, Math.floor(repeats)));
  let burnInTasks = Number(burnInArg);
  if (!Number.isFinite(burnInTasks)) burnInTasks = 20;
  burnInTasks = Math.min(500, Math.max(0, Math.floor(burnInTasks)));
  let noiseThresholdPct = Number(noiseThresholdArg);
  if (!Number.isFinite(noiseThresholdPct)) noiseThresholdPct = 1;
  let minCompressionPct = Number(minCompressionArg);
  if (!Number.isFinite(minCompressionPct)) minCompressionPct = 20;
  let maxCompressedOverheadPct = Number(maxCompressedOverheadArg);
  if (!Number.isFinite(maxCompressedOverheadPct)) maxCompressedOverheadPct = 25;
  let minRawSignalHitRate = Number(minRawSignalArg);
  if (!Number.isFinite(minRawSignalHitRate)) minRawSignalHitRate = 0.99;
  const enforceGates = enforceGatesArg === 'true';
  const useMemoization = useMemoArg !== 'false';
  const useOptimizer = useOptimizerArg !== 'false';
  const profile = profileArg === 'cold' ? 'cold' : 'warm';
  const taskPack = taskPackArg === 'flow' || taskPackArg === 'control' ? taskPackArg : 'mixed';
  const selectedTaskTemplates = getTaskTemplates(taskPack);
  const rand = createRng(`${repoUrl}|${tasksPerMode}|${repeats}|${seedArg}`);

  const root = process.cwd();
  const repoDir = path.join(root, '.bench', 'repos', repoNameFromUrl(repoUrl));

  console.log('=== Task-bound Three-way Benchmark ===');
  console.log(`repo:          ${repoUrl}`);
  console.log(`local:         ${repoDir}`);
  console.log(`tasks_per_mode: ${requestedTasks}`);
  console.log(`edit_and_revert: ${enableEdits}`);
  console.log(`repeats:       ${repeats}`);
  console.log(`json_out:      ${jsonOutArg}`);
  console.log(`csv_out:       ${csvOutArg}`);
  console.log(`profile:       ${profile}`);
  console.log(`task_pack:     ${taskPack}`);
  console.log(`burn_in_tasks: ${burnInTasks}`);
  console.log(`seed:          ${seedArg}`);
  console.log(`noise_pct:     ${noiseThresholdPct}`);
  console.log(`gates:         compression>=${minCompressionPct}% overhead<=${maxCompressedOverheadPct}% raw_signal>=${minRawSignalHitRate}`);
  console.log(`enforce_gates: ${enforceGates}`);
  console.log(`memoization:   ${useMemoization}`);
  console.log(`optimizer:     ${useOptimizer}`);
  console.log('');

  ensureRepo(repoUrl, repoDir);

  const idx0 = performance.now();
  const idx = await indexProject(repoDir, { force: false });
  const idx1 = performance.now();
  console.log(`index: files_scanned=${idx.files_scanned}, files_changed=${idx.files_changed}, ms=${Math.round(idx1 - idx0)}`);

  if (!gitIsClean(repoDir)) {
    throw new Error(`Benchmark repo is not clean before run: ${repoDir}`);
  }

  const seedDb = await GraphDB.open(getDbPath(repoDir));
  const seedScenarios = generateScenarios(seedDb, Math.max(30, Math.min(300, tasksPerMode)), taskPack);
  seedDb.close();
  const scenarios = extendToLength(seedScenarios, tasksPerMode);
  REPO_FILE_COUNT = listSourceFiles(repoDir).length;
  STRATEGY_ACCUMULATOR = new StrategyAccumulator();
  const tuneDb = await GraphDB.open(getDbPath(repoDir));
  const tuned = useOptimizer
    ? tuneCompressionPolicy(tuneDb, repoDir, scenarios, minCompressionPct, maxCompressedOverheadPct)
    : { policy: { ...DEFAULT_COMPRESSION_POLICY }, eval: null };
  tuneDb.close();
  let compressionPolicy = tuned.policy;

  console.log(`effective:     ${tasksPerMode} tasks/mode`);
  console.log('task_catalog:');
  for (const t of selectedTaskTemplates) console.log(`- ${t.id}: ${t.title}`);
  if (tuned.eval) {
    console.log(`optimizer_pick: min_payload=${compressionPolicy.minPayloadBytes} bytes, max_skeleton=${compressionPolicy.maxSkeletonizeStrings}`);
    console.log(`optimizer_est:  raw_ms=${tuned.eval.avgRawMs.toFixed(2)} cmp_ms=${tuned.eval.avgCmpMs.toFixed(2)} savings=${tuned.eval.savingsPct.toFixed(1)}% overhead=${tuned.eval.overheadPct.toFixed(1)}%`);
  }
  console.log('');

  const perRun = [];

  console.log(`running:       ${tasksPerMode} tasks/mode x ${repeats} runs`);
  console.log('');

  const modeOrderBase = ['without_cgraph', 'without_cgraph_smart', 'cgraph_raw', 'cgraph_compressed'];

  for (let run = 0; run < repeats; run++) {
    if (profile === 'cold') {
      await indexProject(repoDir, { force: true });
    }

    const db = await GraphDB.open(getDbPath(repoDir));
    const runScenarios = rotateScenarios(scenarios, run * 7);
    if (!useMemoization) {
      resetStepCaches();
    } else {
      resetStepCaches();
      precomputeHotSymbols(db, repoDir, runScenarios, compressionPolicy);
    }
    const files = listSourceFiles(repoDir);
    const smartIndex = buildSmartSearchIndex(files);
    const modeOrder = rotateModes(modeOrderBase, run * 3);
    console.log(`run ${run + 1}/${repeats} ... order=${modeOrder.join(' -> ')}`);

    const rowsByMode = {};
    for (const mode of modeOrder) {
      if (burnInTasks > 0) {
        runScenarioLoopForCount(runScenarios, burnInTasks, (sc, i) => {
          if (mode === 'without_cgraph') {
            return runWithOptionalEdit(repoDir, sc, i, enableEdits, () => runWithoutCgraphStep(files, sc.symbol, sc.query));
          }
          if (mode === 'without_cgraph_smart') {
            return runWithOptionalEdit(repoDir, sc, i, enableEdits, () => runWithoutCgraphSmartStep(smartIndex, sc.symbol, sc.query));
          }
          if (mode === 'cgraph_raw') {
            return runWithOptionalEdit(repoDir, sc, i, enableEdits, () =>
              runCgraphRawStep(db, repoDir, sc.symbol, sc.query, sc.taskGroup, compressionPolicy, useMemoization),
            );
          }
          return runWithOptionalEdit(repoDir, sc, i, enableEdits, () =>
            runCgraphCompressedEndToEndStep(db, repoDir, sc.symbol, sc.query, sc.taskGroup, compressionPolicy, useMemoization),
          );
        });
      }

      const rows = runScenarioLoopForCount(runScenarios, tasksPerMode, (sc, i) => {
        if (mode === 'without_cgraph') {
          return runWithOptionalEdit(repoDir, sc, i, enableEdits, () => runWithoutCgraphStep(files, sc.symbol, sc.query));
        }
        if (mode === 'without_cgraph_smart') {
          return runWithOptionalEdit(repoDir, sc, i, enableEdits, () => runWithoutCgraphSmartStep(smartIndex, sc.symbol, sc.query));
        }
        if (mode === 'cgraph_raw') {
          return runWithOptionalEdit(repoDir, sc, i, enableEdits, () =>
            runCgraphRawStep(db, repoDir, sc.symbol, sc.query, sc.taskGroup, compressionPolicy, useMemoization),
          );
        }
        return runWithOptionalEdit(repoDir, sc, i, enableEdits, () =>
          runCgraphCompressedEndToEndStep(db, repoDir, sc.symbol, sc.query, sc.taskGroup, compressionPolicy, useMemoization),
        );
      });
      rowsByMode[mode] = rows;
    }

    const no = summarize('without_cgraph', rowsByMode.without_cgraph || []);
    const smart = summarize('without_cgraph_smart', rowsByMode.without_cgraph_smart || []);
    const raw = summarize('cgraph_raw', rowsByMode.cgraph_raw || []);
    const cmp = summarize('cgraph_compressed', rowsByMode.cgraph_compressed || []);

    perRun.push({ run: run + 1, without_cgraph: no, without_cgraph_smart: smart, cgraph_raw: raw, cgraph_compressed: cmp });
    console.log(
      `  complete: naive=${no.avgMs.toFixed(2)}ms smart=${smart.avgMs.toFixed(2)}ms raw=${raw.avgMs.toFixed(2)}ms compressed=${cmp.avgMs.toFixed(2)}ms`,
    );
    db.close();

    if (!gitIsClean(repoDir)) {
      throw new Error(`Benchmark repo left dirty after run ${run + 1}: ${repoDir}`);
    }
    // Apply strategy learning: adjust compression policy for the next run
    if (run < repeats - 1 && STRATEGY_ACCUMULATOR) {
      compressionPolicy = STRATEGY_ACCUMULATOR.applyLearning(compressionPolicy);
    }
  }

  const noAgg = aggregateMode(
    'without_cgraph',
    perRun.map((r) => r.without_cgraph),
    rand,
  );
  const smartAgg = aggregateMode(
    'without_cgraph_smart',
    perRun.map((r) => r.without_cgraph_smart),
    rand,
  );
  const rawAgg = aggregateMode(
    'cgraph_raw',
    perRun.map((r) => r.cgraph_raw),
    rand,
  );
  const cmpAgg = aggregateMode(
    'cgraph_compressed',
    perRun.map((r) => r.cgraph_compressed),
    rand,
  );

  const sigSmartVsNaive = pairedPermutationPValue(
    perRun.map((r) => r.without_cgraph_smart.avgMs),
    perRun.map((r) => r.without_cgraph.avgMs),
    5000,
    rand,
  );
  const sigRawVsSmart = pairedPermutationPValue(
    perRun.map((r) => r.cgraph_raw.avgMs),
    perRun.map((r) => r.without_cgraph_smart.avgMs),
    5000,
    rand,
  );
  const sigCmpVsRaw = pairedPermutationPValue(
    perRun.map((r) => r.cgraph_compressed.avgMs),
    perRun.map((r) => r.cgraph_raw.avgMs),
    5000,
    rand,
  );

  const no = perRun[perRun.length - 1].without_cgraph;
  const smart = perRun[perRun.length - 1].without_cgraph_smart;
  const raw = perRun[perRun.length - 1].cgraph_raw;
  const cmp = perRun[perRun.length - 1].cgraph_compressed;

  console.log('');
  console.log('Summary Table:');
  console.log('mode'.padEnd(20) + '  steps  total_ms      avg_ms      p50_ms      p95_ms       total_out  file_reads    bytes_read');
  printSummaryRow(no);
  printSummaryRow(smart);
  printSummaryRow(raw);
  printSummaryRow(cmp);

  console.log('');
  console.log('Aggregate (mean ± 95% CI across runs):');
  console.log('mode'.padEnd(20) + '  runs      avg_ms_ci     p50_ms    p95_ms      throughput_ci   avg_out');
  printAggregateRow(noAgg);
  printAggregateRow(smartAgg);
  printAggregateRow(rawAgg);
  printAggregateRow(cmpAgg);
  console.log('');
  printTaskBreakdown('without_cgraph', noAgg.taskBreakdown);
  printTaskBreakdown('without_cgraph_smart', smartAgg.taskBreakdown);
  printTaskBreakdown('cgraph_raw', rawAgg.taskBreakdown);
  printTaskBreakdown('cgraph_compressed', cmpAgg.taskBreakdown);
  printTaskGroupBreakdown('without_cgraph', noAgg.taskGroupBreakdown);
  printTaskGroupBreakdown('without_cgraph_smart', smartAgg.taskGroupBreakdown);
  printTaskGroupBreakdown('cgraph_raw', rawAgg.taskGroupBreakdown);
  printTaskGroupBreakdown('cgraph_compressed', cmpAgg.taskGroupBreakdown);

  const compressionSavedPerStep = raw.avgOut - cmp.avgOut;
  const compressionPctPerStep = raw.avgOut > 0 ? (compressionSavedPerStep / raw.avgOut) * 100 : 0;
  const cgraphReadSavings = no.totalReadBytes - raw.totalReadBytes;
  const noStepsPerSec = no.totalMs > 0 ? (no.steps * 1000) / no.totalMs : 0;
  const rawStepsPerSec = raw.totalMs > 0 ? (raw.steps * 1000) / raw.totalMs : 0;
  const cmpStepsPerSec = cmp.totalMs > 0 ? (cmp.steps * 1000) / cmp.totalMs : 0;

  console.log('');
  console.log('Derived:');
  console.log(`- smart baseline vs naive baseline compute: ${(smart.totalMs / Math.max(no.totalMs, 0.001)).toFixed(2)}x`);
  console.log(`- raw cgraph vs smart baseline total compute: ${(raw.totalMs / Math.max(smart.totalMs, 0.001)).toFixed(2)}x`);
  console.log(`- raw cgraph vs naive baseline total compute: ${(raw.totalMs / Math.max(no.totalMs, 0.001)).toFixed(2)}x`);
  console.log(`- cgraph compressed vs cgraph raw compute: ${(cmp.totalMs / Math.max(raw.totalMs, 0.001)).toFixed(2)}x`);
  console.log(`- compression payload savings per step: ${humanBytes(compressionSavedPerStep)} (${compressionPctPerStep.toFixed(1)}%)`);
  const smartStepsPerSec = smart.totalMs > 0 ? (smart.steps * 1000) / smart.totalMs : 0;
  console.log(`- throughput (steps/sec): naive=${noStepsPerSec.toFixed(2)} smart=${smartStepsPerSec.toFixed(2)} raw=${rawStepsPerSec.toFixed(2)} compressed=${cmpStepsPerSec.toFixed(2)}`);
  console.log(`- file I/O avoided by cgraph: ${no.totalReads} reads, ${humanBytes(cgraphReadSavings)} avoided`);
  console.log(`- signal hit rate: naive=${(no.signalHitRate * 100).toFixed(1)}% smart=${(smart.signalHitRate * 100).toFixed(1)}% raw=${(raw.signalHitRate * 100).toFixed(1)}% compressed=${(cmp.signalHitRate * 100).toFixed(1)}%`);
  console.log(`- fallback reasons (naive): ${formatFallbackReasonCounts(noAgg.fallbackReasonCounts)}`);
  console.log(`- fallback reasons (smart): ${formatFallbackReasonCounts(smartAgg.fallbackReasonCounts)}`);
  console.log(`- fallback reasons (raw): ${formatFallbackReasonCounts(rawAgg.fallbackReasonCounts)}`);
  console.log(`- fallback reasons (compressed): ${formatFallbackReasonCounts(cmpAgg.fallbackReasonCounts)}`);
  console.log(`- outliers (avg_ms per run): naive mild=${noAgg.outliers.mild} severe=${noAgg.outliers.severe}; smart mild=${smartAgg.outliers.mild} severe=${smartAgg.outliers.severe}; raw mild=${rawAgg.outliers.mild} severe=${rawAgg.outliers.severe}; compressed mild=${cmpAgg.outliers.mild} severe=${cmpAgg.outliers.severe}`);
  console.log(`- significance: ${formatSigResult('smart_vs_naive', sigSmartVsNaive, noiseThresholdPct)}`);
  console.log(`- significance: ${formatSigResult('raw_vs_smart', sigRawVsSmart, noiseThresholdPct)}`);
  console.log(`- significance: ${formatSigResult('compressed_vs_raw', sigCmpVsRaw, noiseThresholdPct)}`);

  const compressedOverheadPct = rawAgg.avgMsMean > 0 ? ((cmpAgg.avgMsMean - rawAgg.avgMsMean) / rawAgg.avgMsMean) * 100 : 0;
  const compressionSavingsPct = rawAgg.avgOutMean > 0 ? ((rawAgg.avgOutMean - cmpAgg.avgOutMean) / rawAgg.avgOutMean) * 100 : 0;
  const gateFailures = [];
  if (compressionSavingsPct < minCompressionPct) {
    gateFailures.push(`compression_savings_pct ${compressionSavingsPct.toFixed(2)} < ${minCompressionPct}`);
  }
  if (compressedOverheadPct > maxCompressedOverheadPct) {
    gateFailures.push(`compressed_overhead_pct ${compressedOverheadPct.toFixed(2)} > ${maxCompressedOverheadPct}`);
  }
  if (rawAgg.signalHitRateMean < minRawSignalHitRate) {
    gateFailures.push(`raw_signal_hit_rate ${rawAgg.signalHitRateMean.toFixed(3)} < ${minRawSignalHitRate}`);
  }
  console.log(`- gates: ${gateFailures.length === 0 ? 'pass' : `fail (${gateFailures.join('; ')})`}`);
  console.log(`- repo_budget_tier: ${rawAgg.repoBudgetTier} (file_count=${REPO_FILE_COUNT})`);
  console.log(`- avg_blast_radius (raw): ${rawAgg.avgBlastRadius.toFixed(1)}`);
  console.log(`- query_confidence (smart): ${formatFallbackReasonCounts(smartAgg.queryConfidenceCounts)}`);
  console.log(`- compression_kinds (compressed): ${formatFallbackReasonCounts(cmpAgg.compressionKindCounts)}`);

  const jsonOutPath = path.isAbsolute(jsonOutArg) ? jsonOutArg : path.join(root, jsonOutArg);
  fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      repoUrl,
      repoDir,
      tasksPerMode,
      repeats,
      enableEdits,
      profile,
      taskPack,
      burnInTasks,
      taskCatalog: selectedTaskTemplates,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus()?.length || 0,
        cpuModel: os.cpus()?.[0]?.model || 'unknown',
        memoryGB: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
      },
      git: {
        benchmarkRepoHead: execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim(),
        targetRepoHead: execSync('git -C "' + repoDir + '" rev-parse HEAD', { encoding: 'utf8' }).trim(),
      },
      config: {
        seed: seedArg,
        noiseThresholdPct,
        minCompressionPct,
        maxCompressedOverheadPct,
        minRawSignalHitRate,
        enforceGates,
        useMemoization,
        useOptimizer,
        compressionPolicy,
      },
    },
    perRun,
    aggregate: {
      without_cgraph: noAgg,
      without_cgraph_smart: smartAgg,
      cgraph_raw: rawAgg,
      cgraph_compressed: cmpAgg,
      derived: {
        smartVsNaiveTotalCompute: smartAgg.totalMsMean / Math.max(noAgg.totalMsMean, 0.001),
        rawVsSmartTotalCompute: rawAgg.totalMsMean / Math.max(smartAgg.totalMsMean, 0.001),
        rawVsWithoutTotalCompute: rawAgg.totalMsMean / Math.max(noAgg.totalMsMean, 0.001),
        compressedVsRawTotalCompute: cmpAgg.totalMsMean / Math.max(rawAgg.totalMsMean, 0.001),
        compressionPayloadSavingsPerTask: rawAgg.avgOutMean - cmpAgg.avgOutMean,
        compressionPayloadSavingsPct:
          rawAgg.avgOutMean > 0 ? ((rawAgg.avgOutMean - cmpAgg.avgOutMean) / rawAgg.avgOutMean) * 100 : 0,
        cgraphReadsAvoidedMean: noAgg.totalReadsMean - rawAgg.totalReadsMean,
        cgraphBytesAvoidedMean: noAgg.totalReadBytesMean - rawAgg.totalReadBytesMean,
        significance: {
          smartVsNaive: sigSmartVsNaive,
          rawVsSmart: sigRawVsSmart,
          compressedVsRaw: sigCmpVsRaw,
        },
        qualityGates: {
          compressionSavingsPct,
          compressedOverheadPct,
          rawSignalHitRate: rawAgg.signalHitRateMean,
          gateFailures,
          passed: gateFailures.length === 0,
        },
        repoBudgetTier: rawAgg.repoBudgetTier,
        avgBlastRadius: rawAgg.avgBlastRadius,
        compressionKinds: cmpAgg.compressionKindCounts,
        queryConfidence: {
          smart: smartAgg.queryConfidenceCounts,
          raw: rawAgg.queryConfidenceCounts,
          compressed: cmpAgg.queryConfidenceCounts,
        },
      },
    },
  };
  fs.writeFileSync(jsonOutPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`- json report: ${jsonOutPath}`);

  const csvOutPath = path.isAbsolute(csvOutArg) ? csvOutArg : path.join(root, csvOutArg);
  writeCsvReport(csvOutPath, perRun, {
    without_cgraph: noAgg,
    without_cgraph_smart: smartAgg,
    cgraph_raw: rawAgg,
    cgraph_compressed: cmpAgg,
  });
  console.log(`- csv report: ${csvOutPath}`);

  if (enforceGates && gateFailures.length > 0) {
    throw new Error(`Quality gates failed: ${gateFailures.join('; ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
