#!/usr/bin/env node
/* Sustained local workload and fault-injection harness for durable memory. */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { GraphDB } = require('../dist/storage');
const { getDbPath } = require('../dist/config');
const { MemoryService } = require('../dist/memory');

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : Number(args[index + 1]);
};
const durationMs = value('--duration-ms', 10_000);
const writeRate = value('--write-rate', 20);
const readRate = value('--read-rate', 40);
const fault = args.includes('--fault') ? args[args.indexOf('--fault') + 1] : 'none';
const root = mkdtempSync(join(tmpdir(), 'cgraph-memory-soak-'));
const latencies = []; let writes = 0; let reads = 0; let failures = 0; let restarts = 0;

(async () => {
  let db = await GraphDB.open(getDbPath(root));
  let service = new MemoryService(db);
  service.registerPrincipal({ principalId: 'soak.agent', trustTier: 'trusted', metadata: { namespaces: ['soak'] } });
  const started = Date.now(); let sequence = 0;
  while (Date.now() - started < durationMs) {
    const cycleStarted = performance.now();
    try {
      for (let index = 0; index < writeRate; index++) {
        const result = service.writeMemory({ principalId: 'soak.agent', namespace: 'soak', subjectKey: `subject-${sequence % 10}`, memoryId: `memory-${sequence}`, idempotencyKey: `soak-${sequence}`, payload: { sequence }, confidence: .8, evidence: [{ sourceType: 'soak', sourceRef: String(sequence) }] });
        if (!result.ok) failures++; else writes++;
        sequence++;
      }
      for (let index = 0; index < readRate; index++) { service.queryMemory({ namespace: 'soak', subjectKey: `subject-${index % 10}`, principalId: 'soak.agent', limit: 5 }); reads++; }
      if (fault === 'restart' && sequence % (writeRate * 3) === 0) {
        MemoryService.closeForGraphPath(getDbPath(root)); db.close();
        db = await GraphDB.open(getDbPath(root)); service = new MemoryService(db); restarts++;
      }
      if (fault === 'revocation' && sequence >= writeRate * 2) { service.revokePrincipal({ principalId: 'soak.agent', reason: 'fault' }); failures += writeRate; break; }
    } catch { failures++; }
    latencies.push(performance.now() - cycleStarted);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0;
  const elapsed = Math.max(1, Date.now() - started);
  console.log(JSON.stringify({ duration_ms: elapsed, fault, writes, reads, failures, restarts, error_rate_ppm: Math.round(failures * 1_000_000 / Math.max(1, writes + reads + failures)), cycle_latency_ms: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }, throughput_ops_sec: (writes + reads) / (elapsed / 1_000), metrics: service.getMetrics() }, null, 2));
  MemoryService.closeForGraphPath(getDbPath(root)); db.close(); rmSync(root, { recursive: true, force: true });
})().catch((error) => { console.error(error); process.exitCode = 1; });
