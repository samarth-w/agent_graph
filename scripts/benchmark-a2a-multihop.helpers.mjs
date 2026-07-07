export const DEFAULT_BUDGET = {
  minRootCauseAccuracy: 0.95,
  minAgentSpeedup: 2,
  maxGraphRpcCalls: 1,
  maxGraphAvgTimeMs: 90,
  maxGraphTimeRegressionPct: 50,
  minConflictResolutionAccuracy: 0.9,
  minCostVisibilityCoverage: 0.9,
};

export function parseCliArgs(argv) {
  let runs = 20;
  let savePath;
  let comparePath;
  let budgetPath;
  let enforce = false;
  const thresholds = {};

  const args = [...argv];
  if (args.length > 0 && !args[0].startsWith('-')) {
    const first = Number(args[0]);
    if (Number.isFinite(first) && first > 0) {
      runs = Math.floor(first);
      args.shift();
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--save') {
      savePath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--compare') {
      comparePath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--budget') {
      budgetPath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--enforce') {
      enforce = true;
      continue;
    }
    if (arg === '--min-root-cause-accuracy') {
      thresholds.minRootCauseAccuracy = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--min-agent-speedup') {
      thresholds.minAgentSpeedup = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--max-graph-rpc-calls') {
      thresholds.maxGraphRpcCalls = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--max-graph-time-ms') {
      thresholds.maxGraphAvgTimeMs = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--max-graph-time-regression-pct') {
      thresholds.maxGraphTimeRegressionPct = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--min-conflict-resolution-accuracy') {
      thresholds.minConflictResolutionAccuracy = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--min-cost-visibility-coverage') {
      thresholds.minCostVisibilityCoverage = Number(args[i + 1]);
      i += 1;
      continue;
    }
  }

  return { runs, savePath, comparePath, budgetPath, enforce, thresholds };
}

export function coerceBudget(raw = {}, defaults = DEFAULT_BUDGET) {
  return {
    minRootCauseAccuracy: typeof raw.minRootCauseAccuracy === 'number' ? raw.minRootCauseAccuracy : defaults.minRootCauseAccuracy,
    minAgentSpeedup: typeof raw.minAgentSpeedup === 'number' ? raw.minAgentSpeedup : defaults.minAgentSpeedup,
    maxGraphRpcCalls: typeof raw.maxGraphRpcCalls === 'number' ? raw.maxGraphRpcCalls : defaults.maxGraphRpcCalls,
    maxGraphAvgTimeMs: typeof raw.maxGraphAvgTimeMs === 'number' ? raw.maxGraphAvgTimeMs : defaults.maxGraphAvgTimeMs,
    maxGraphTimeRegressionPct: typeof raw.maxGraphTimeRegressionPct === 'number' ? raw.maxGraphTimeRegressionPct : defaults.maxGraphTimeRegressionPct,
    minConflictResolutionAccuracy: typeof raw.minConflictResolutionAccuracy === 'number' ? raw.minConflictResolutionAccuracy : defaults.minConflictResolutionAccuracy,
    minCostVisibilityCoverage: typeof raw.minCostVisibilityCoverage === 'number' ? raw.minCostVisibilityCoverage : defaults.minCostVisibilityCoverage,
  };
}

export function mergeThresholds(base, overrides) {
  const merged = { ...base };
  if (Number.isFinite(overrides.minRootCauseAccuracy)) merged.minRootCauseAccuracy = overrides.minRootCauseAccuracy;
  if (Number.isFinite(overrides.minAgentSpeedup)) merged.minAgentSpeedup = overrides.minAgentSpeedup;
  if (Number.isFinite(overrides.maxGraphRpcCalls)) merged.maxGraphRpcCalls = overrides.maxGraphRpcCalls;
  if (Number.isFinite(overrides.maxGraphAvgTimeMs)) merged.maxGraphAvgTimeMs = overrides.maxGraphAvgTimeMs;
  if (Number.isFinite(overrides.maxGraphTimeRegressionPct)) merged.maxGraphTimeRegressionPct = overrides.maxGraphTimeRegressionPct;
  if (Number.isFinite(overrides.minConflictResolutionAccuracy)) merged.minConflictResolutionAccuracy = overrides.minConflictResolutionAccuracy;
  if (Number.isFinite(overrides.minCostVisibilityCoverage)) merged.minCostVisibilityCoverage = overrides.minCostVisibilityCoverage;
  return merged;
}

export function evaluateBudget(payload, thresholds) {
  const violations = [];
  const summary = payload.summary;

  if (summary.root_cause_accuracy < thresholds.minRootCauseAccuracy) {
    violations.push(`root_cause_accuracy ${summary.root_cause_accuracy} < minRootCauseAccuracy ${thresholds.minRootCauseAccuracy}`);
  }
  if (summary.estimated_agent_speedup_vs_flat < thresholds.minAgentSpeedup) {
    violations.push(`estimated_agent_speedup_vs_flat ${summary.estimated_agent_speedup_vs_flat} < minAgentSpeedup ${thresholds.minAgentSpeedup}`);
  }
  if (summary.graph_trace.avg_rpc_calls > thresholds.maxGraphRpcCalls) {
    violations.push(`graph_trace.avg_rpc_calls ${summary.graph_trace.avg_rpc_calls} > maxGraphRpcCalls ${thresholds.maxGraphRpcCalls}`);
  }
  if (summary.graph_trace.avg_time_ms > thresholds.maxGraphAvgTimeMs) {
    violations.push(`graph_trace.avg_time_ms ${summary.graph_trace.avg_time_ms} > maxGraphAvgTimeMs ${thresholds.maxGraphAvgTimeMs}`);
  }
  if (summary.conflict_resolution_accuracy < thresholds.minConflictResolutionAccuracy) {
    violations.push(`conflict_resolution_accuracy ${summary.conflict_resolution_accuracy} < minConflictResolutionAccuracy ${thresholds.minConflictResolutionAccuracy}`);
  }
  if (summary.graph_trace.cost_visibility_coverage < thresholds.minCostVisibilityCoverage) {
    violations.push(`graph_trace.cost_visibility_coverage ${summary.graph_trace.cost_visibility_coverage} < minCostVisibilityCoverage ${thresholds.minCostVisibilityCoverage}`);
  }

  const regression = payload.comparison?.delta?.graph_avg_time_ms_pct;
  if (typeof regression === 'number' && regression > thresholds.maxGraphTimeRegressionPct) {
    violations.push(`comparison.delta.graph_avg_time_ms_pct ${regression}% > maxGraphTimeRegressionPct ${thresholds.maxGraphTimeRegressionPct}%`);
  }

  return {
    ok: violations.length === 0,
    violations,
    thresholds,
  };
}

export function pctDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return Number((((current - baseline) / baseline) * 100).toFixed(3));
}

export function absDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  return Number((current - baseline).toFixed(4));
}

export function compareWithBaseline(currentPayload, baselinePayload) {
  const current = currentPayload?.summary;
  const baseline = baselinePayload?.summary;
  if (!current || !baseline) {
    throw new Error('Baseline payload missing required "summary" section.');
  }

  return {
    baseline_timestamp: baselinePayload.timestamp ?? null,
    current_timestamp: currentPayload.timestamp ?? null,
    delta: {
      root_cause_accuracy: Number((current.root_cause_accuracy - baseline.root_cause_accuracy).toFixed(4)),
      estimated_agent_speedup_vs_flat_pct: pctDelta(
        current.estimated_agent_speedup_vs_flat,
        baseline.estimated_agent_speedup_vs_flat,
      ),
      flat_avg_tool_calls_pct: pctDelta(
        current.flat_log.avg_tool_calls,
        baseline.flat_log.avg_tool_calls,
      ),
      graph_avg_rpc_calls_pct: pctDelta(
        current.graph_trace.avg_rpc_calls,
        baseline.graph_trace.avg_rpc_calls,
      ),
      graph_avg_time_ms_pct: pctDelta(
        current.graph_trace.avg_time_ms,
        baseline.graph_trace.avg_time_ms,
      ),
      flat_avg_time_ms_pct: pctDelta(
        current.flat_log.avg_time_ms,
        baseline.flat_log.avg_time_ms,
      ),
      conflict_resolution_accuracy: absDelta(
        current.conflict_resolution_accuracy,
        baseline.conflict_resolution_accuracy,
      ),
      graph_cost_visibility_coverage_pct: pctDelta(
        current.graph_trace.cost_visibility_coverage,
        baseline.graph_trace.cost_visibility_coverage,
      ),
    },
  };
}
