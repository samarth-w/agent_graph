import fs from 'fs';
import path from 'path';
import { GraphDB } from '../storage';
import { searchSymbols, intentSearch } from '../search';
import { buildContext, explore } from '../context';
import { analyzeImpact, evaluateImpactCases, getProjectStats } from '../graph';
import type { ImpactEvaluationCase } from '../types';

export interface CapabilitySmokeCheck {
  name: string;
  status: 'ok' | 'failed';
  detail: string;
}

export interface CapabilitySmokeReport {
  root_dir: string;
  target_symbol: string;
  ok: boolean;
  passed: number;
  failed: number;
  checks: CapabilitySmokeCheck[];
}

export function loadImpactEvaluationCasesFromFile(filePath: string): ImpactEvaluationCase[] {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Impact evaluation cases file not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Impact evaluation cases file must contain a JSON array.');
  }

  return parsed.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Case at index ${idx} must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : `case-${idx + 1}`;
    const target = typeof item.target === 'string' ? item.target : '';
    const expectedSymbols = Array.isArray(item.expected_symbols)
      ? item.expected_symbols.filter((v): v is string => typeof v === 'string')
      : [];
    const mode = item.mode === 'decision' ? 'decision' : 'discovery';
    if (!target) {
      throw new Error(`Case at index ${idx} is missing a non-empty target.`);
    }
    return { name, target, expected_symbols: expectedSymbols, mode };
  });
}

export function evaluateImpactCasesFromFile(
  db: GraphDB,
  rootDir: string,
  filePath: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
) {
  const cases = loadImpactEvaluationCasesFromFile(filePath);
  return evaluateImpactCases(db, rootDir, cases, opts);
}

export async function runCapabilitySmokeCheck(
  db: GraphDB,
  rootDir: string,
  opts: { targetSymbol?: string; maxDepth?: number; maxNodes?: number } = {},
): Promise<CapabilitySmokeReport> {
  const targetSymbol = opts.targetSymbol ?? 'main';
  const checks: CapabilitySmokeCheck[] = [];
  const push = (name: string, status: 'ok' | 'failed', detail: string) => {
    checks.push({ name, status, detail });
  };

  try {
    const results = searchSymbols(db, targetSymbol, { limit: 5 });
    push('search', 'ok', `${results.length} result(s)`);
  } catch (err: any) {
    push('search', 'failed', err.message);
  }

  try {
    const payload = buildContext(db, rootDir, targetSymbol);
    push('context', 'ok', `${payload.nodes.length} node(s), ${payload.snippets.length} snippet(s)`);
  } catch (err: any) {
    push('context', 'failed', err.message);
  }

  try {
    const result = analyzeImpact(db, targetSymbol, {
      maxDepth: opts.maxDepth ?? 2,
      maxNodes: opts.maxNodes ?? 10,
      rootDir,
      mode: 'discovery',
    });
    const impactedCount = Array.isArray((result as any).impacted_nodes)
      ? (result as any).impacted_nodes.length
      : 0;
    push('impact', 'ok', `${impactedCount} impacted node(s)`);
  } catch (err: any) {
    push('impact', 'failed', err.message);
  }

  try {
    const stats = getProjectStats(db) as any;
    const indexedNodes = typeof stats?.total_nodes === 'number'
      ? stats.total_nodes
      : (typeof stats?.nodes_total === 'number'
        ? stats.nodes_total
        : (typeof stats?.nodes === 'number' ? stats.nodes : 0));
    push('stats', 'ok', `${indexedNodes} indexed node(s)`);
  } catch (err: any) {
    push('stats', 'failed', err.message);
  }

  const passed = checks.filter(check => check.status === 'ok').length;
  const failed = checks.length - passed;
  return {
    root_dir: rootDir,
    target_symbol: targetSymbol,
    ok: failed === 0,
    passed,
    failed,
    checks,
  };
}
