import type { PrSummary } from './pr-summary';
import type { GateResult } from './gate';

export function formatOverviewMarkdown(payload: {
  root_dir: string;
  summary: { total_files: number; total_nodes: number; total_edges: number; avg_fan_in: number; avg_fan_out: number };
  health: { modularity: number; dead_code: number; test_coverage: number; complexity: number; overall: number };
  architecture: { style: string; languages: Array<{ lang: string; files: number; percentage: number }>; roles: Record<string, number> };
  hotspots: Array<{ symbol: string; file: string; coupling: number }>;
}): string {
  const lines: string[] = [];
  lines.push('# cgraph Overview');
  lines.push('');
  lines.push(`- Root: ${payload.root_dir}`);
  lines.push(`- Files: ${payload.summary.total_files}`);
  lines.push(`- Symbols: ${payload.summary.total_nodes}`);
  lines.push(`- Edges: ${payload.summary.total_edges}`);
  lines.push(`- Avg fan-in/out: ${payload.summary.avg_fan_in}/${payload.summary.avg_fan_out}`);
  lines.push(`- Overall health: ${payload.health.overall}/100`);
  lines.push('');
  lines.push('## Health');
  lines.push(`- Modularity: ${payload.health.modularity}`);
  lines.push(`- Dead code: ${payload.health.dead_code}`);
  lines.push(`- Test coverage: ${payload.health.test_coverage}`);
  lines.push(`- Complexity: ${payload.health.complexity}`);
  lines.push('');
  lines.push('## Architecture');
  lines.push(`- Style: ${payload.architecture.style}`);
  lines.push(`- Languages: ${payload.architecture.languages.map(l => `${l.lang}(${l.files})`).join(', ') || 'none'}`);
  lines.push('');
  lines.push('## Hotspots');
  const top = payload.hotspots.slice(0, 5);
  if (top.length === 0) {
    lines.push('- None');
  } else {
    for (const hotspot of top) {
      lines.push(`- ${hotspot.symbol} (${hotspot.file}) coupling=${hotspot.coupling}`);
    }
  }
  return lines.join('\n');
}

export function formatPrSummaryMarkdown(summary: PrSummary): string {
  const lines: string[] = [];
  lines.push('# cgraph PR Summary');
  lines.push('');
  lines.push(`- Risk: ${summary.risk_level} (${summary.risk_score}/100)`);
  lines.push(`- Changed files: ${summary.changed_files.length}`);
  lines.push(`- Changed symbols: ${summary.total_changed_symbols}`);
  lines.push(`- Impacted symbols: ${summary.total_impacted}`);
  lines.push(`- Affected tests: ${summary.affected_tests.length}`);
  lines.push('');
  lines.push('## Recommendations');
  for (const rec of summary.recommendations) {
    lines.push(`- ${rec}`);
  }
  return lines.join('\n');
}

export function formatGateMarkdown(result: GateResult): string {
  const lines: string[] = [];
  lines.push('# cgraph Gate Result');
  lines.push('');
  lines.push(`- Passed: ${result.passed}`);
  lines.push(`- Risk: ${result.pr_summary.risk_level} (${result.pr_summary.risk_score}/100)`);
  lines.push('');
  lines.push('## Checks');
  for (const check of result.checks) {
    lines.push(`- ${check.name}: ${check.passed ? 'PASS' : 'FAIL'} (actual=${check.actual}, expected=${check.expected})`);
  }
  return lines.join('\n');
}
