import { GraphDB } from '../storage';
import { analyzeImpact, findAffected } from '../graph';
import { findChangedSymbols, getChangedFiles, type ChangedSymbol } from '../git';

export interface PrSummary {
  root_dir: string;
  changed_files: string[];
  changed_symbols: ChangedSymbol[];
  impacted_files: string[];
  impacted_symbols: string[];
  affected_tests: string[];
  total_impacted: number;
  total_changed_symbols: number;
  risk_level: 'low' | 'medium' | 'high';
  risk_score: number;
  recommendations: string[];
}

function scoreRisk(opts: {
  changedFiles: number;
  changedSymbols: number;
  impactedSymbols: number;
  affectedTests: number;
  warnings: number;
}): { riskScore: number; riskLevel: 'low' | 'medium' | 'high' } {
  let riskScore = 0;
  riskScore += opts.changedFiles * 4;
  riskScore += opts.changedSymbols * 3;
  riskScore += opts.impactedSymbols * 2;
  riskScore += opts.warnings * 4;

  // If no tests are affected, increase risk because coverage of blast radius is unclear.
  if (opts.affectedTests === 0) riskScore += 12;

  const clamped = Math.max(0, Math.min(100, riskScore));
  const riskLevel = clamped < 25 ? 'low' : clamped < 60 ? 'medium' : 'high';
  return { riskScore: clamped, riskLevel };
}

function buildRecommendations(summary: {
  changedFiles: number;
  changedSymbols: number;
  impactedSymbols: number;
  affectedTests: number;
  riskLevel: 'low' | 'medium' | 'high';
}): string[] {
  const recommendations: string[] = [];
  if (summary.changedFiles === 0) {
    recommendations.push('No changed files detected. Provide --files or run inside a git working tree with changes.');
    return recommendations;
  }
  if (summary.affectedTests === 0) {
    recommendations.push('No affected tests were detected. Consider adding targeted regression tests for changed symbols.');
  } else {
    recommendations.push('Run affected tests first to validate likely blast radius before full-suite runs.');
  }
  if (summary.impactedSymbols > 40) {
    recommendations.push('Large impact set detected. Consider splitting this PR into smaller, reviewable slices.');
  }
  if (summary.riskLevel === 'high') {
    recommendations.push('High risk detected. Prefer decision-mode review and explicit rollout safeguards.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Risk appears controlled. Proceed with normal review flow.');
  }
  return recommendations;
}

export function buildPrSummary(
  db: GraphDB,
  rootDir: string,
  opts: {
    files?: string[];
    ref?: string;
    staged?: boolean;
    depth?: number;
    maxNodes?: number;
    mode?: 'discovery' | 'decision';
    testPattern?: string;
  } = {},
): PrSummary {
  const changedFiles = opts.files && opts.files.length > 0
    ? opts.files
    : getChangedFiles(rootDir, { ref: opts.ref, staged: opts.staged }).map(c => c.file);

  const changedSymbols = opts.files && opts.files.length > 0
    ? changedFiles.flatMap(file => {
        const rec = db.getFile(file);
        if (!rec) return [];
        return db.getNodesForFile(rec.id).map(n => ({
          name: n.name,
          qualified_name: n.qualified_name,
          kind: n.kind,
          file,
          start_line: n.start_line,
          end_line: n.end_line,
          change_type: 'in_changed_file' as const,
        }));
      })
    : findChangedSymbols(db, rootDir, { ref: opts.ref, staged: opts.staged });

  const impactedFiles = new Set<string>();
  const impactedSymbols = new Set<string>();
  let warningCount = 0;
  for (const sym of changedSymbols.slice(0, 30)) {
    const impact = analyzeImpact(db, sym.name, {
      maxDepth: opts.depth ?? 3,
      maxNodes: opts.maxNodes ?? 80,
      rootDir,
      mode: opts.mode ?? 'decision',
    });
    warningCount += impact.warnings.length;
    for (const file of impact.impacted_files) impactedFiles.add(file);
    for (const node of impact.impacted_nodes) impactedSymbols.add(node.qualified_name);
  }

  const affected = findAffected(db, changedFiles, {
    depth: opts.depth ?? 4,
    testPattern: opts.testPattern,
  });

  const { riskScore, riskLevel } = scoreRisk({
    changedFiles: changedFiles.length,
    changedSymbols: changedSymbols.length,
    impactedSymbols: impactedSymbols.size,
    affectedTests: affected.affected_tests.length,
    warnings: warningCount,
  });

  const recommendations = buildRecommendations({
    changedFiles: changedFiles.length,
    changedSymbols: changedSymbols.length,
    impactedSymbols: impactedSymbols.size,
    affectedTests: affected.affected_tests.length,
    riskLevel,
  });

  return {
    root_dir: rootDir,
    changed_files: changedFiles,
    changed_symbols: changedSymbols,
    impacted_files: [...impactedFiles].sort(),
    impacted_symbols: [...impactedSymbols].sort(),
    affected_tests: affected.affected_tests,
    total_impacted: impactedSymbols.size,
    total_changed_symbols: changedSymbols.length,
    risk_level: riskLevel,
    risk_score: riskScore,
    recommendations,
  };
}
