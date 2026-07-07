#!/usr/bin/env node
/**
 * Multi-hop A2A benchmark harness.
 *
 * Compares flat-log diagnosis vs graph-lineage diagnosis for finding
 * the first bad hop in an agent chain.
 *
 * Usage:
 *   node scripts/benchmark-a2a-multihop.mjs [runs]
 *     [--save reports/a2a.json]
 *     [--compare reports/baseline.json]
 *     [--budget fixtures/a2a-benchmark-budget.json]
 *     [--enforce]
 *     [--min-root-cause-accuracy 0.95]
 *     [--min-agent-speedup 2.0]
 *     [--max-graph-rpc-calls 1]
 *     [--max-graph-time-ms 40]
 *     [--max-graph-time-regression-pct 25]
 *     [--min-conflict-resolution-accuracy 0.9]
 *     [--min-cost-visibility-coverage 0.9]
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  parseCliArgs,
  coerceBudget,
  mergeThresholds,
  evaluateBudget,
  compareWithBaseline,
} from './benchmark-a2a-multihop.helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_A2A = path.resolve(ROOT, 'dist', 'a2a.js');

const cli = parseCliArgs(process.argv.slice(2));
const RUNS = cli.runs;
const AGENT_ROUNDTRIP_MS = 2000;

if (!fs.existsSync(DIST_A2A)) {
  process.stderr.write('Missing dist/a2a.js. Run "npm run build" first.\n');
  process.exit(1);
}

const { handleA2ARpcRequest } = await import(pathToFileURL(DIST_A2A).href);

const chainAgents = ['research-agent', 'summarizer-agent', 'fact-checker-agent'];
const badHopIndex = 1;

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-a2a-bench-'));
}

function parseDoc(doc) {
  if (!doc) return {};
  try {
    return JSON.parse(doc);
  } catch {
    return {};
  }
}

function makeClaim(agentId) {
  return JSON.stringify({ agent_id: agentId, capabilities: ['write_node'] });
}

function signClaim(claim) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { signature, publicKeyPem };
}

async function rpc(rootDir, id, method, params = {}) {
  const response = await handleA2ARpcRequest(rootDir, {
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
  if (response.error) {
    throw new Error(`${method} failed: ${response.error.message}`);
  }
  return response.result;
}

function diagnoseFlat(logEntries, targetQName) {
  const t0 = performance.now();
  let scans = 0;
  let toolCalls = 0;

  let cursor = logEntries.find(entry => {
    scans += 1;
    return entry.qualified_name === targetQName;
  });
  toolCalls += 1;

  const lineage = [];
  while (cursor) {
    lineage.push(cursor);
    if (!cursor.parent_qname) break;
    cursor = logEntries.find(entry => {
      scans += 1;
      return entry.qualified_name === cursor.parent_qname;
    });
    toolCalls += 1;
  }

  const reversed = [...lineage].reverse();
  const firstBad = reversed.find(node => node.quality === 'bad');

  return {
    elapsed_ms: performance.now() - t0,
    scans,
    tool_calls: toolCalls,
    agent_estimated_ms: toolCalls * AGENT_ROUNDTRIP_MS,
    lineage_depth: reversed.length,
    root_cause: firstBad ? firstBad.qualified_name : null,
  };
}

async function diagnoseGraph(rootDir, targetQName) {
  const t0 = performance.now();
  const lineage = await rpc(rootDir, 'lineage', 'read_lineage', {
    qualified_name: targetQName,
    max_depth: 8,
    max_nodes: 128,
  });

  const nodes = Array.isArray(lineage.nodes) ? lineage.nodes : [];
  const ordered = [...nodes].sort((a, b) => b.depth - a.depth);
  const firstBad = ordered.find(node => parseDoc(node.doc).quality === 'bad');
  const relevantNodes = ordered.filter(node => {
    const parsed = parseDoc(node.doc);
    return parsed && typeof parsed.quality === 'string';
  });
  const costVisible = relevantNodes.filter(node => {
    const parsed = parseDoc(node.doc);
    return parsed && typeof parsed.cost === 'object' && typeof parsed.cost.est_cost_usd === 'number';
  }).length;
  const costVisibilityCoverage = relevantNodes.length > 0
    ? Number((costVisible / relevantNodes.length).toFixed(4))
    : 0;

  return {
    elapsed_ms: performance.now() - t0,
    rpc_calls: 1,
    agent_estimated_ms: AGENT_ROUNDTRIP_MS,
    lineage_depth: ordered.length,
    root_cause: firstBad ? firstBad.qualified_name : null,
    cost_visibility_coverage: costVisibilityCoverage,
  };
}

function resolveConflictCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { winner: null, alternatives: [] };
  }
  const maxTimestamp = Math.max(...candidates.map(c => c.timestamp_ms));
  const scored = candidates.map(candidate => {
    const trust = candidate.trust_status === 'verified' ? 1 : 0;
    const recency = maxTimestamp > 0 ? candidate.timestamp_ms / maxTimestamp : 0;
    const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : 0;
    const score = trust * 0.5 + recency * 0.3 + confidence * 0.2;
    return { ...candidate, score: Number(score.toFixed(6)) };
  }).sort((a, b) => b.score - a.score);

  return {
    winner: scored[0],
    alternatives: scored.slice(1),
  };
}

async function runOne(index) {
  const rootDir = createTempRoot();
  const flatLog = [];

  try {
    for (const agentId of chainAgents) {
      const claim = makeClaim(agentId);
      const signed = signClaim(claim);
      await rpc(rootDir, `register-${agentId}`, 'register_agent', {
        agent_id: agentId,
        claim,
        signature: signed.signature,
        public_key: signed.publicKeyPem,
      });
    }

    let parentQName = undefined;
    let finalQName = '';

    for (let hop = 0; hop < chainAgents.length; hop += 1) {
      const agentId = chainAgents[hop];
      const quality = hop === badHopIndex ? 'bad' : 'ok';
      const doc = JSON.stringify({
        run: index,
        hop,
        agent_id: agentId,
        quality,
        confidence: quality === 'bad' ? 0.25 : 0.9,
        note: quality === 'bad' ? 'Injected faulty claim' : 'Normal output',
        cost: {
          tokens_in: 120 + hop * 20,
          tokens_out: 80 + hop * 15,
          latency_ms: 8 + hop,
          est_cost_usd: 0.0003 + hop * 0.0001,
        },
      });
      const filePath = `a2a/bench/run-${index}/${hop}-${agentId}.json`;
      const qualifiedName = `${filePath}::result_${hop}`;

      const writeRes = await rpc(rootDir, `write-${agentId}`, 'write_node', {
        agent_id: agentId,
        name: `result_${hop}`,
        kind: 'variable',
        file_path: filePath,
        qualified_name: qualifiedName,
        parent_qname: parentQName,
        doc,
        cost: {
          tokens_in: 120 + hop * 20,
          tokens_out: 80 + hop * 15,
          latency_ms: 8 + hop,
          est_cost_usd: 0.0003 + hop * 0.0001,
        },
      });

      flatLog.push({
        agent_id: agentId,
        qualified_name: qualifiedName,
        parent_qname: parentQName,
        quality,
        trust_status: writeRes.trust_status,
        confidence: quality === 'bad' ? 0.25 : 0.9,
        timestamp_ms: Date.now() + hop,
        cost: {
          tokens_in: 120 + hop * 20,
          tokens_out: 80 + hop * 15,
          latency_ms: 8 + hop,
          est_cost_usd: 0.0003 + hop * 0.0001,
        },
      });

      parentQName = qualifiedName;
      finalQName = qualifiedName;
    }

    const flatResult = diagnoseFlat(flatLog, finalQName);
    const graphResult = await diagnoseGraph(rootDir, finalQName);

    const conflictParent = flatLog[badHopIndex].qualified_name;
    const conflictCandidates = [
      {
        candidate_id: `${conflictParent}::candidate_good`,
        trust_status: 'verified',
        confidence: 0.9,
        timestamp_ms: Date.now() + 2,
      },
      {
        candidate_id: `${conflictParent}::candidate_bad`,
        trust_status: 'unverified',
        confidence: 0.3,
        timestamp_ms: Date.now() + 1,
      },
    ];
    const resolvedConflict = resolveConflictCandidates(conflictCandidates);
    const expectedWinner = `${conflictParent}::candidate_good`;
    const conflictCorrect = resolvedConflict.winner?.candidate_id === expectedWinner;

    const flatCostVisible = flatLog.filter(entry => entry.cost && typeof entry.cost.est_cost_usd === 'number').length;
    const flatCostCoverage = flatLog.length > 0
      ? Number((flatCostVisible / flatLog.length).toFixed(4))
      : 0;

    return {
      run: index,
      final_node: finalQName,
      expected_root_cause: flatLog[badHopIndex].qualified_name,
      conflict_expected_winner: expectedWinner,
      conflict_winner: resolvedConflict.winner?.candidate_id ?? null,
      conflict_correct: conflictCorrect,
      conflict_alternatives: resolvedConflict.alternatives,
      flat: flatResult,
      graph: graphResult,
      cost_visibility: {
        flat: flatCostCoverage,
        graph: graphResult.cost_visibility_coverage,
      },
      root_cause_match: flatResult.root_cause === graphResult.root_cause,
    };
  } finally {
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }
}

function summarize(results) {
  const avg = (arr) => arr.length === 0 ? 0 : arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const flatTimes = results.map(r => r.flat.elapsed_ms);
  const graphTimes = results.map(r => r.graph.elapsed_ms);
  const flatScans = results.map(r => r.flat.scans);
  const flatCalls = results.map(r => r.flat.tool_calls);
  const graphCalls = results.map(r => r.graph.rpc_calls);
  const flatAgentMs = results.map(r => r.flat.agent_estimated_ms);
  const graphAgentMs = results.map(r => r.graph.agent_estimated_ms);
  const matches = results.filter(r => r.root_cause_match).length;
  const conflictMatches = results.filter(r => r.conflict_correct).length;
  const graphCostVisibility = results.map(r => r.cost_visibility.graph);
  const flatCostVisibility = results.map(r => r.cost_visibility.flat);

  return {
    runs: results.length,
    root_cause_matches: matches,
    root_cause_accuracy: Number((matches / Math.max(1, results.length)).toFixed(4)),
    conflict_resolution_matches: conflictMatches,
    conflict_resolution_accuracy: Number((conflictMatches / Math.max(1, results.length)).toFixed(4)),
    flat_log: {
      avg_time_ms: Number(avg(flatTimes).toFixed(3)),
      avg_scans: Number(avg(flatScans).toFixed(2)),
      avg_tool_calls: Number(avg(flatCalls).toFixed(2)),
      avg_agent_estimated_ms: Number(avg(flatAgentMs).toFixed(2)),
    },
    graph_trace: {
      avg_time_ms: Number(avg(graphTimes).toFixed(3)),
      avg_rpc_calls: Number(avg(graphCalls).toFixed(2)),
      avg_agent_estimated_ms: Number(avg(graphAgentMs).toFixed(2)),
      cost_visibility_coverage: Number(avg(graphCostVisibility).toFixed(4)),
    },
    flat_cost_visibility_coverage: Number(avg(flatCostVisibility).toFixed(4)),
    compute_speedup_vs_flat: Number((avg(flatTimes) / Math.max(0.0001, avg(graphTimes))).toFixed(3)),
    estimated_agent_speedup_vs_flat: Number((avg(flatAgentMs) / Math.max(1, avg(graphAgentMs))).toFixed(3)),
  };
}

function loadBudget(budgetPath) {
  if (!budgetPath) return coerceBudget({});
  const absolutePath = path.resolve(process.cwd(), budgetPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Budget file not found: ${absolutePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  return coerceBudget(raw);
}

function writeJsonReport(targetPath, payload) {
  const absolutePath = path.resolve(process.cwd(), targetPath);
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return absolutePath;
}

const results = [];
for (let i = 0; i < RUNS; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  results.push(await runOne(i + 1));
}

const payload = {
  benchmark: 'a2a-multihop',
  status: 'completed',
  timestamp: new Date().toISOString(),
  chain: chainAgents,
  injected_bad_hop: badHopIndex,
  summary: summarize(results),
  sample_run: results[0],
};

if (cli.comparePath) {
  const baselinePath = path.resolve(process.cwd(), cli.comparePath);
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline report not found: ${baselinePath}`);
  }
  const baselinePayload = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  payload.comparison = compareWithBaseline(payload, baselinePayload);
}

const budgetThresholds = mergeThresholds(loadBudget(cli.budgetPath), cli.thresholds);
payload.gate = evaluateBudget(payload, budgetThresholds);

if (cli.savePath) {
  const savedTo = writeJsonReport(cli.savePath, payload);
  payload.saved_to = savedTo;
}

process.stdout.write(JSON.stringify(payload, null, 2) + '\n');

if (cli.enforce && payload.gate && !payload.gate.ok) {
  process.exit(1);
}
