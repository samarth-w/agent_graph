#!/usr/bin/env node
const { GraphDB } = require('../dist/storage');
const { getDbPath } = require('../dist/config');
const { MemoryService } = require('../dist/memory');

async function main() {
  const [rootDir, workerId, countText] = process.argv.slice(2);
  const count = Number(countText);
  const graphPath = getDbPath(rootDir);
  const db = await GraphDB.open(graphPath);
  const service = new MemoryService(db);
  const principalId = 'agent.multi-process';
  service.registerPrincipal({ principalId, trustTier: 'trusted', metadata: { namespaces: ['workspace'] } });
  const results = [];
  for (let index = 0; index < count; index++) {
    results.push(service.writeMemory({
      principalId,
      namespace: 'workspace',
      subjectKey: `worker-${workerId}`,
      memoryType: 'observation',
      memoryId: `worker-${workerId}-${index}`,
      idempotencyKey: `worker-${workerId}-key-${index}`,
      payload: { workerId, index },
      confidence: 0.8,
      evidence: [{ sourceType: 'multi_process', sourceRef: `${workerId}:${index}` }],
    }));
  }
  MemoryService.closeForGraphPath(graphPath);
  db.close();
  process.stdout.write(JSON.stringify({ ok: results.every((result) => result.ok), count: results.length }) + '\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
