import fs from 'fs';
import os from 'os';
import path from 'path';
import { GraphDB } from '../dist/storage.js';
import { MemoryService } from '../dist/memory.js';
import { getDbPath } from '../dist/config.js';

const samples = Number(process.argv[2] ?? 200);
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-memory-benchmark-'));
const percentile = (values, p) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;

try {
  const db = await GraphDB.open(getDbPath(rootDir));
  const service = new MemoryService(db);
  service.registerPrincipal({ principalId: 'benchmark', trustTier: 'trusted' });
  const writes = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    const result = service.writeMemory({
      principalId: 'benchmark', namespace: 'benchmark', subjectKey: `subject-${index % 20}`,
      memoryType: 'observation', payload: { index }, confidence: 0.8,
      evidence: [{ sourceType: 'benchmark', sourceRef: String(index) }],
    });
    if (!result.ok) throw new Error(result.error);
    writes.push(performance.now() - started);
  }
  const queries = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    service.queryMemory({ namespace: 'benchmark', subjectKey: `subject-${index % 20}`, requireEvidence: true });
    queries.push(performance.now() - started);
  }
  const compactionStarted = performance.now();
  service.compactMemory({ retentionMs: 1 });
  const compactionMs = performance.now() - compactionStarted;
  writes.sort((a, b) => a - b);
  queries.sort((a, b) => a - b);
  console.log(JSON.stringify({
    samples,
    write_ms: { p50: percentile(writes, 0.5), p95: percentile(writes, 0.95) },
    query_ms: { p50: percentile(queries, 0.5), p95: percentile(queries, 0.95) },
    compaction_ms: compactionMs,
    mixed_ops_per_second: samples * 2 / ((writes.reduce((a, b) => a + b, 0) + queries.reduce((a, b) => a + b, 0)) / 1000),
  }, null, 2));
} finally {
  MemoryService.closeForGraphPath(getDbPath(rootDir));
  fs.rmSync(rootDir, { recursive: true, force: true });
}
