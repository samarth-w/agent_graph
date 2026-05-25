/**
 * Architecture linting — enforce structural rules against the code graph.
 */
import { GraphDB } from './storage';
import { findCycles } from './graph';
import type { LintRule, LintViolation, LintResult } from './types';

/** Simple glob matcher: supports * (any segment) and ** (any depth) */
function globMatch(pattern: string, filePath: string): boolean {
  const patParts = pattern.replace(/\\/g, '/').split('/');
  const pathParts = filePath.replace(/\\/g, '/').split('/');
  return matchParts(patParts, pathParts, 0, 0);
}

function matchParts(pat: string[], path: string[], pi: number, fi: number): boolean {
  while (pi < pat.length && fi < path.length) {
    if (pat[pi] === '**') {
      // ** matches zero or more segments
      for (let skip = fi; skip <= path.length; skip++) {
        if (matchParts(pat, path, pi + 1, skip)) return true;
      }
      return false;
    }
    if (pat[pi] === '*' || pat[pi] === path[fi]) {
      pi++;
      fi++;
    } else {
      return false;
    }
  }
  // Skip trailing **
  while (pi < pat.length && pat[pi] === '**') pi++;
  return pi === pat.length && fi === path.length;
}

export function lintArchitecture(db: GraphDB, rules: LintRule[]): LintResult {
  const violations: LintViolation[] = [];

  for (const rule of rules) {
    switch (rule.type) {
      case 'deny-dependency': {
        if (!rule.from || !rule.to) break;
        const allEdges = db.getAllEdges();
        for (const edge of allEdges) {
          const src = db.getNode(edge.source_id);
          const tgt = db.getNode(edge.target_id);
          if (!src || !tgt) continue;
          const srcFile = db.getFileById(src.file_id)?.path ?? '';
          const tgtFile = db.getFileById(tgt.file_id)?.path ?? '';
          if (globMatch(rule.from, srcFile) && globMatch(rule.to, tgtFile)) {
            violations.push({
              rule,
              symbol: `${src.name} → ${tgt.name}`,
              file: srcFile,
              detail: rule.message ?? `Forbidden dependency: ${srcFile} → ${tgtFile}`,
            });
          }
        }
        break;
      }

      case 'max-fan-out': {
        const max = rule.max ?? 10;
        const allNodes = db.getAllNodes();
        for (const node of allNodes) {
          if (rule.scope) {
            const fp = db.getFileById(node.file_id)?.path ?? '';
            if (!globMatch(rule.scope, fp)) continue;
          }
          const fanOut = db.getEdgesFrom(node.id, 'calls').length;
          if (fanOut > max) {
            violations.push({
              rule,
              symbol: node.name,
              file: db.getFileById(node.file_id)?.path,
              detail: rule.message ?? `Fan-out ${fanOut} exceeds max ${max}`,
            });
          }
        }
        break;
      }

      case 'no-cycles': {
        const result = findCycles(db, { maxCycles: 20 });
        for (const cycle of result.cycles) {
          if (rule.scope) {
            const inScope = cycle.files.some(f => globMatch(rule.scope!, f));
            if (!inScope) continue;
          }
          violations.push({
            rule,
            detail: rule.message ?? `Cycle: ${cycle.path.join(' → ')}`,
          });
        }
        break;
      }

      case 'max-file-symbols': {
        const max = rule.max ?? 30;
        const allFiles = db.getAllFiles();
        for (const file of allFiles) {
          if (rule.scope && !globMatch(rule.scope, file.path)) continue;
          const count = db.getNodesForFile(file.id).length;
          if (count > max) {
            violations.push({
              rule,
              file: file.path,
              detail: rule.message ?? `File has ${count} symbols (max ${max})`,
            });
          }
        }
        break;
      }
    }
  }

  const errors = violations.filter(v => v.rule.severity === 'error').length;
  const warnings = violations.filter(v => v.rule.severity === 'warn').length;
  const passed = errors === 0;
  const summary = passed
    ? `All rules passed${warnings > 0 ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}.`
    : `${errors} error${errors > 1 ? 's' : ''}, ${warnings} warning${warnings > 1 ? 's' : ''}.`;

  return { passed, violations, errors, warnings, summary };
}
