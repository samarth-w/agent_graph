import { describe, it, expect } from 'vitest';
import {
  parseCliArgs,
  coerceBudget,
  mergeThresholds,
  evaluateBudget,
  compareWithBaseline,
} from '../scripts/benchmark-a2a-multihop.helpers.mjs';

describe('benchmark-a2a-multihop helpers', () => {
  it('parses runs and benchmark flags', () => {
    const parsed = parseCliArgs([
      '15',
      '--compare', 'reports/base.json',
      '--save', 'reports/current.json',
      '--budget', 'fixtures/a2a-benchmark-budget.json',
      '--enforce',
      '--min-conflict-resolution-accuracy', '0.92',
      '--min-cost-visibility-coverage', '0.91',
    ]);

    expect(parsed.runs).toBe(15);
    expect(parsed.comparePath).toBe('reports/base.json');
    expect(parsed.savePath).toBe('reports/current.json');
    expect(parsed.budgetPath).toBe('fixtures/a2a-benchmark-budget.json');
    expect(parsed.enforce).toBe(true);
    expect(parsed.thresholds.minConflictResolutionAccuracy).toBe(0.92);
    expect(parsed.thresholds.minCostVisibilityCoverage).toBe(0.91);
  });

  it('enforces new conflict and cost thresholds', () => {
    const payload = {
      summary: {
        root_cause_accuracy: 1,
        estimated_agent_speedup_vs_flat: 3,
        conflict_resolution_accuracy: 0.7,
        graph_trace: {
          avg_rpc_calls: 1,
          avg_time_ms: 10,
          cost_visibility_coverage: 0.6,
        },
      },
      comparison: {
        delta: {
          graph_avg_time_ms_pct: 10,
        },
      },
    };

    const budget = mergeThresholds(coerceBudget({}), {
      minConflictResolutionAccuracy: 0.9,
      minCostVisibilityCoverage: 0.9,
    });

    const gate = evaluateBudget(payload as any, budget);
    expect(gate.ok).toBe(false);
    expect(gate.violations.some(v => v.includes('conflict_resolution_accuracy'))).toBe(true);
    expect(gate.violations.some(v => v.includes('cost_visibility_coverage'))).toBe(true);
  });

  it('keeps baseline comparison backward-compatible for new metrics', () => {
    const current = {
      timestamp: '2026-01-02T00:00:00.000Z',
      summary: {
        root_cause_accuracy: 1,
        estimated_agent_speedup_vs_flat: 3,
        conflict_resolution_accuracy: 1,
        flat_log: { avg_tool_calls: 3, avg_time_ms: 0.03 },
        graph_trace: {
          avg_rpc_calls: 1,
          avg_time_ms: 12,
          cost_visibility_coverage: 1,
        },
      },
    };

    const legacyBaseline = {
      timestamp: '2026-01-01T00:00:00.000Z',
      summary: {
        root_cause_accuracy: 1,
        estimated_agent_speedup_vs_flat: 3,
        flat_log: { avg_tool_calls: 3, avg_time_ms: 0.02 },
        graph_trace: { avg_rpc_calls: 1, avg_time_ms: 10 },
      },
    };

    const compared = compareWithBaseline(current as any, legacyBaseline as any);
    expect(compared.delta.conflict_resolution_accuracy).toBeNull();
    expect(compared.delta.graph_cost_visibility_coverage_pct).toBeNull();
  });
});
