import { GraphDB } from '../storage';
import { findCycles, findDeadCode, getCodebaseDNA } from '../graph';
import { buildPrSummary } from './pr-summary';
import type { GateConfig } from '../types';

export interface GateCheck {
  name: string;
  actual: number;
  expected: string;
  passed: boolean;
}

export interface GateResult {
  root_dir: string;
  passed: boolean;
  thresholds: Required<GateConfig>;
  checks: GateCheck[];
  pr_summary: {
    changed_files: number;
    affected_tests: number;
    risk_level: 'low' | 'medium' | 'high';
    risk_score: number;
  };
}

const DEFAULT_GATE: Required<GateConfig> = {
  maxCycles: 2,
  maxDeadSymbols: 60,
  minOverallHealth: 70,
  maxRiskScore: 60,
  requireAffectedTests: false,
};

function resolveThresholds(config?: GateConfig, overrides: Partial<Required<GateConfig>> = {}): Required<GateConfig> {
  return {
    maxCycles: overrides.maxCycles ?? config?.maxCycles ?? DEFAULT_GATE.maxCycles,
    maxDeadSymbols: overrides.maxDeadSymbols ?? config?.maxDeadSymbols ?? DEFAULT_GATE.maxDeadSymbols,
    minOverallHealth: overrides.minOverallHealth ?? config?.minOverallHealth ?? DEFAULT_GATE.minOverallHealth,
    maxRiskScore: overrides.maxRiskScore ?? config?.maxRiskScore ?? DEFAULT_GATE.maxRiskScore,
    requireAffectedTests: overrides.requireAffectedTests ?? config?.requireAffectedTests ?? DEFAULT_GATE.requireAffectedTests,
  };
}

export function evaluateGate(
  db: GraphDB,
  rootDir: string,
  opts: {
    config?: GateConfig;
    files?: string[];
    ref?: string;
    staged?: boolean;
    depth?: number;
    maxNodes?: number;
    mode?: 'discovery' | 'decision';
    testPattern?: string;
    maxCycles?: number;
    maxDeadSymbols?: number;
    minOverallHealth?: number;
    maxRiskScore?: number;
    requireAffectedTests?: boolean;
  } = {},
): GateResult {
  const thresholds = resolveThresholds(opts.config, {
    maxCycles: opts.maxCycles,
    maxDeadSymbols: opts.maxDeadSymbols,
    minOverallHealth: opts.minOverallHealth,
    maxRiskScore: opts.maxRiskScore,
    requireAffectedTests: opts.requireAffectedTests,
  });

  const cycles = findCycles(db, { maxCycles: Math.max(thresholds.maxCycles + 20, 50) }).total;
  const dead = findDeadCode(db, { limit: 1 }).total;
  const healthOverall = getCodebaseDNA(db).health.overall;
  const prSummary = buildPrSummary(db, rootDir, {
    files: opts.files,
    ref: opts.ref,
    staged: opts.staged,
    depth: opts.depth,
    maxNodes: opts.maxNodes,
    mode: opts.mode,
    testPattern: opts.testPattern,
  });

  const checks: GateCheck[] = [
    { name: 'cycles', actual: cycles, expected: `<= ${thresholds.maxCycles}`, passed: cycles <= thresholds.maxCycles },
    { name: 'dead_symbols', actual: dead, expected: `<= ${thresholds.maxDeadSymbols}`, passed: dead <= thresholds.maxDeadSymbols },
    { name: 'overall_health', actual: healthOverall, expected: `>= ${thresholds.minOverallHealth}`, passed: healthOverall >= thresholds.minOverallHealth },
    { name: 'risk_score', actual: prSummary.risk_score, expected: `<= ${thresholds.maxRiskScore}`, passed: prSummary.risk_score <= thresholds.maxRiskScore },
  ];

  if (thresholds.requireAffectedTests) {
    checks.push({
      name: 'affected_tests',
      actual: prSummary.affected_tests.length,
      expected: '>= 1',
      passed: prSummary.affected_tests.length >= 1,
    });
  }

  return {
    root_dir: rootDir,
    passed: checks.every(c => c.passed),
    thresholds,
    checks,
    pr_summary: {
      changed_files: prSummary.changed_files.length,
      affected_tests: prSummary.affected_tests.length,
      risk_level: prSummary.risk_level,
      risk_score: prSummary.risk_score,
    },
  };
}
