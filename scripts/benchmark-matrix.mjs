#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function geometricMean(values) {
  const filtered = values.filter((v) => v > 0);
  if (!filtered.length) return 0;
  const logAvg = filtered.reduce((s, v) => s + Math.log(v), 0) / filtered.length;
  return Math.exp(logAvg);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const vals = headers.map((k) => {
      const v = row[k];
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
      return s;
    });
    lines.push(vals.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function defaultRepoMatrix() {
  return [
    { name: 'axios', size: 'S', url: 'https://github.com/axios/axios.git' },
    { name: 'express', size: 'M', url: 'https://github.com/expressjs/express.git' },
    { name: 'next.js', size: 'L', url: 'https://github.com/vercel/next.js.git' },
  ];
}

function parseReposArg(value) {
  if (!value) return defaultRepoMatrix();
  // Format: name:size:url;name:size:url
  const out = [];
  for (const part of value.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const bits = seg.split(':');
    if (bits.length < 3) continue;
    const name = bits[0];
    const size = bits[1];
    const url = bits.slice(2).join(':');
    out.push({ name, size, url });
  }
  return out.length ? out : defaultRepoMatrix();
}

function main() {
  const tasks = Number(process.argv[2] || '120');
  const repeats = Number(process.argv[3] || '3');
  const taskPack = (process.argv[4] || 'mixed').toLowerCase();
  const outJson = process.argv[5] || '.bench/results/matrix-summary.json';
  const outCsv = process.argv[6] || '.bench/results/matrix-summary.csv';
  const reposArg = process.argv[7] || '';
  const repos = parseReposArg(reposArg);

  const root = process.cwd();
  const benchScript = path.join(root, 'scripts', 'benchmark-three-way-expansive.mjs');
  const nodeExe = process.execPath;

  console.log('=== Benchmark Matrix (S/M/L) ===');
  console.log(`tasks=${tasks} repeats=${repeats} task_pack=${taskPack}`);
  console.log(`repos=${repos.map((r) => `${r.name}(${r.size})`).join(', ')}`);

  const perRepo = [];

  for (const repo of repos) {
    const jsonPath = path.join(root, '.bench', 'results', `matrix-${repo.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
    const csvPath = path.join(root, '.bench', 'results', `matrix-${repo.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.csv`);

    const args = [
      benchScript,
      repo.url,
      String(tasks),
      'true',
      String(repeats),
      jsonPath,
      csvPath,
      'warm',
      '20',
      'seed42',
      '1',
      '20',
      '25',
      '0.99',
      'false',
      taskPack,
    ];

    console.log(`\n--- ${repo.name} (${repo.size}) ---`);
    const run = spawnSync(nodeExe, args, { stdio: 'inherit', cwd: root });
    if (run.status !== 0) {
      throw new Error(`Benchmark failed for ${repo.name} (exit ${run.status})`);
    }

    const data = readJson(jsonPath);
    const agg = data.aggregate;
    const der = agg.derived;

    perRepo.push({
      repo: repo.name,
      size: repo.size,
      url: repo.url,
      naive_avg_ms: agg.without_cgraph.avgMsMean,
      smart_avg_ms: agg.without_cgraph_smart.avgMsMean,
      raw_avg_ms: agg.cgraph_raw.avgMsMean,
      compressed_avg_ms: agg.cgraph_compressed.avgMsMean,
      compression_savings_pct: der.compressionPayloadSavingsPct,
      compressed_overhead_pct: ((agg.cgraph_compressed.avgMsMean - agg.cgraph_raw.avgMsMean) / Math.max(agg.cgraph_raw.avgMsMean, 0.001)) * 100,
      raw_signal_hit_rate: agg.cgraph_raw.signalHitRateMean,
      smart_signal_hit_rate: agg.without_cgraph_smart.signalHitRateMean,
      reads_avoided_mean: der.cgraphReadsAvoidedMean,
      bytes_avoided_mean: der.cgraphBytesAvoidedMean,
      gate_passed: der.qualityGates?.passed ?? true,
      gate_failures: (der.qualityGates?.gateFailures || []).join('|'),
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    config: { tasks, repeats, taskPack },
    repos: perRepo,
    aggregate: {
      compressionSavingsPctMean: mean(perRepo.map((r) => r.compression_savings_pct)),
      compressedOverheadPctMean: mean(perRepo.map((r) => r.compressed_overhead_pct)),
      rawSignalHitRateMean: mean(perRepo.map((r) => r.raw_signal_hit_rate)),
      smartSignalHitRateMean: mean(perRepo.map((r) => r.smart_signal_hit_rate)),
      naiveAvgMsGeoMean: geometricMean(perRepo.map((r) => r.naive_avg_ms)),
      smartAvgMsGeoMean: geometricMean(perRepo.map((r) => r.smart_avg_ms)),
      rawAvgMsGeoMean: geometricMean(perRepo.map((r) => r.raw_avg_ms)),
      compressedAvgMsGeoMean: geometricMean(perRepo.map((r) => r.compressed_avg_ms)),
      allGatesPassed: perRepo.every((r) => r.gate_passed),
    },
  };

  const absJson = path.isAbsolute(outJson) ? outJson : path.join(root, outJson);
  const absCsv = path.isAbsolute(outCsv) ? outCsv : path.join(root, outCsv);
  fs.mkdirSync(path.dirname(absJson), { recursive: true });
  fs.mkdirSync(path.dirname(absCsv), { recursive: true });
  fs.writeFileSync(absJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  fs.writeFileSync(absCsv, toCsv(perRepo), 'utf8');

  console.log('\n=== Matrix Summary ===');
  console.log(`compression_savings_mean=${summary.aggregate.compressionSavingsPctMean.toFixed(2)}%`);
  console.log(`compressed_overhead_mean=${summary.aggregate.compressedOverheadPctMean.toFixed(2)}%`);
  console.log(`raw_signal_hit_rate_mean=${summary.aggregate.rawSignalHitRateMean.toFixed(3)}`);
  console.log(`all_gates_passed=${summary.aggregate.allGatesPassed}`);
  console.log(`json=${absJson}`);
  console.log(`csv=${absCsv}`);
}

main();
