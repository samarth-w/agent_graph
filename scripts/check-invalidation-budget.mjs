/**
 * CI gate for invalidation quality.
 *
 * Runs the five-arm evaluation and fails the build when accuracy regresses.
 * Thresholds live in fixtures/invalidation-quality-budget.json.
 *
 * The gate is deliberately asymmetric: recall is held to a much tighter bound
 * than precision, because the two errors are not equally costly. A false
 * negative leaves an agent acting on a belief the code no longer supports; a
 * false positive only forces knowledge to be re-derived.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(
  fs.readFileSync(path.join(root, 'fixtures', 'invalidation-quality-budget.json'), 'utf8'),
);

const goldPath = path.join(root, budget.goldPath);
if (!fs.existsSync(goldPath)) {
  // Keep the repository lightweight: generate the corpus on demand when the
  // fixture is absent (CI, clean clone, or local cleanup).
  execFileSync(
    process.execPath,
    [path.join(root, 'scripts', 'gen-invalidation-corpus.mjs'), '--out', budget.goldPath],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

const output = execFileSync(
  process.execPath,
  [
    path.join(root, 'scripts', 'eval-invalidation.mjs'),
    '--gold', budget.goldPath,
    '--level', String(budget.fingerprintLevel),
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const report = JSON.parse(output.slice(output.indexOf('{')));
const ours = report.arms.B5_cgraph;
const baseline = report.arms[budget.mustBeatArm];
const failures = [];

if (report.judgementCount < budget.minJudgements) {
  failures.push(`only ${report.judgementCount} judgements, expected >= ${budget.minJudgements}`);
}
if (ours.recall < budget.minRecall) {
  failures.push(
    `recall ${ours.recall} below ${budget.minRecall} ` +
    `(${ours.fn} missed invalidations — agents would act on stale beliefs)`,
  );
}
if (ours.f1 < budget.minF1) {
  failures.push(`F1 ${ours.f1} below ${budget.minF1}`);
}
if (ours.knowledgeRetentionRate < budget.minKnowledgeRetentionRate) {
  failures.push(
    `knowledge retention ${ours.knowledgeRetentionRate} below ${budget.minKnowledgeRetentionRate}`,
  );
}
const margin = Number((ours.f1 - baseline.f1).toFixed(4));
if (margin < budget.minF1MarginOverBaseline) {
  failures.push(
    `F1 margin over ${budget.mustBeatArm} is ${margin}, below ${budget.minF1MarginOverBaseline}`,
  );
}

if (failures.length > 0) {
  throw new Error(`Invalidation quality gate failed:\n  - ${failures.join('\n  - ')}`);
}

console.log(JSON.stringify({
  status: 'passed',
  judgements: report.judgementCount,
  ours,
  baseline: { arm: budget.mustBeatArm, ...baseline },
  f1MarginOverBaseline: margin,
}, null, 2));
