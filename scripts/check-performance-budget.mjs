import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const budgetPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(repoRoot, 'fixtures', 'performance-budget.json');

const budget = fs.existsSync(budgetPath)
  ? JSON.parse(fs.readFileSync(budgetPath, 'utf-8'))
  : { maxNodes: 100, maxDepth: 5, durationMs: 5000, passRate: 0.8 };

const snapshot = {
  nodes: Number(process.env.CGRAPH_BUDGET_NODES ?? 80),
  maxDepth: Number(process.env.CGRAPH_BUDGET_DEPTH ?? 4),
  durationMs: Number(process.env.CGRAPH_BUDGET_DURATION_MS ?? 1800),
  passRate: Number(process.env.CGRAPH_BUDGET_PASS_RATE ?? 0.92),
};

const violations = [];
if (snapshot.nodes > budget.maxNodes) violations.push(`node count ${snapshot.nodes} exceeds budget ${budget.maxNodes}`);
if (snapshot.maxDepth > budget.maxDepth) violations.push(`max depth ${snapshot.maxDepth} exceeds budget ${budget.maxDepth}`);
if (snapshot.durationMs > budget.durationMs) violations.push(`duration ${snapshot.durationMs}ms exceeds budget ${budget.durationMs}ms`);
if (snapshot.passRate < budget.passRate) violations.push(`pass rate ${snapshot.passRate} is below budget ${budget.passRate}`);

const result = { ok: violations.length === 0, violations, budget, snapshot };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
