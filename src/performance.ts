import fs from 'fs';
import path from 'path';

export interface PerformanceBudget {
  maxNodes: number;
  maxDepth: number;
  durationMs: number;
  passRate: number;
}

export interface PerformanceSnapshot {
  nodes?: number;
  maxDepth?: number;
  durationMs?: number;
  passRate?: number;
}

export interface PerformanceBudgetResult {
  ok: boolean;
  violations: string[];
  budget: PerformanceBudget;
  snapshot: PerformanceSnapshot;
}

const DEFAULT_BUDGET: PerformanceBudget = {
  maxNodes: 100,
  maxDepth: 5,
  durationMs: 5000,
  passRate: 0.8,
};

export function loadPerformanceBudget(filePath: string): PerformanceBudget {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return { ...DEFAULT_BUDGET };
  }

  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as Partial<PerformanceBudget>;
  return {
    maxNodes: typeof parsed.maxNodes === 'number' ? parsed.maxNodes : DEFAULT_BUDGET.maxNodes,
    maxDepth: typeof parsed.maxDepth === 'number' ? parsed.maxDepth : DEFAULT_BUDGET.maxDepth,
    durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : DEFAULT_BUDGET.durationMs,
    passRate: typeof parsed.passRate === 'number' ? parsed.passRate : DEFAULT_BUDGET.passRate,
  };
}

export function checkPerformanceBudget(
  snapshot: PerformanceSnapshot,
  budget: PerformanceBudget = DEFAULT_BUDGET,
): PerformanceBudgetResult {
  const violations: string[] = [];

  if (typeof snapshot.nodes === 'number' && snapshot.nodes > budget.maxNodes) {
    violations.push(`node count ${snapshot.nodes} exceeds budget ${budget.maxNodes}`);
  }

  const depth = typeof snapshot.maxDepth === 'number' ? snapshot.maxDepth : undefined;
  if (typeof depth === 'number' && depth > budget.maxDepth) {
    violations.push(`max depth ${depth} exceeds budget ${budget.maxDepth}`);
  }

  if (typeof snapshot.durationMs === 'number' && snapshot.durationMs > budget.durationMs) {
    violations.push(`duration ${snapshot.durationMs}ms exceeds budget ${budget.durationMs}ms`);
  }

  if (typeof snapshot.passRate === 'number' && snapshot.passRate < budget.passRate) {
    violations.push(`pass rate ${snapshot.passRate} is below budget ${budget.passRate}`);
  }

  return {
    ok: violations.length === 0,
    violations,
    budget,
    snapshot,
  };
}
