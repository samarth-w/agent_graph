import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'memory-performance-budget.json'), 'utf8'));
const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'benchmark-memory.mjs'), String(budget.samples)], {
  cwd: root,
  encoding: 'utf8',
});
const start = output.indexOf('{');
const result = JSON.parse(output.slice(start));
const failures = [];
if (result.write_ms.p95 > budget.writeP95Ms) failures.push(`write p95 ${result.write_ms.p95}ms exceeds ${budget.writeP95Ms}ms`);
if (result.query_ms.p95 > budget.queryP95Ms) failures.push(`query p95 ${result.query_ms.p95}ms exceeds ${budget.queryP95Ms}ms`);
if (result.mixed_ops_per_second < budget.minimumMixedOpsPerSecond) failures.push(`throughput ${result.mixed_ops_per_second} below ${budget.minimumMixedOpsPerSecond}`);
if (failures.length > 0) throw new Error(`Persistent memory SLO failed: ${failures.join('; ')}`);
console.log(JSON.stringify({ status: 'passed', budget, result }, null, 2));
