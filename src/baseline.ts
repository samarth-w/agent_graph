import fs from 'fs';
import path from 'path';
import { GraphDB } from './storage';
import { indexProject } from './indexer';
import { getCodebaseDNA, getProjectStats } from './graph';

export interface ProjectHealthSnapshot {
  label: string;
  created_at: string;
  root_dir: string;
  summary: {
    total_files: number;
    total_nodes: number;
    total_edges: number;
    avg_fan_in: number;
    avg_fan_out: number;
  };
  health: {
    modularity: number;
    dead_code: number;
    test_coverage: number;
    complexity: number;
    overall: number;
  };
  architecture: {
    style: string;
    languages: Array<{ lang: string; files: number; percentage: number }>;
    roles: Record<string, number>;
  };
}

export interface BaselineHistory {
  version: 1;
  snapshots: ProjectHealthSnapshot[];
}

export function getBaselineStorePath(rootDir: string): string {
  return path.join(rootDir, '.cgraph', 'baselines.json');
}

function defaultHistory(): BaselineHistory {
  return { version: 1, snapshots: [] };
}

function readHistory(rootDir: string): BaselineHistory {
  const storePath = getBaselineStorePath(rootDir);
  if (!fs.existsSync(storePath)) return defaultHistory();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    if (!raw || typeof raw !== 'object') return defaultHistory();
    const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
    return { version: 1, snapshots };
  } catch {
    return defaultHistory();
  }
}

function writeHistory(rootDir: string, history: BaselineHistory): void {
  const storePath = getBaselineStorePath(rootDir);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(history, null, 2));
}

export async function collectProjectSnapshot(rootDir: string): Promise<ProjectHealthSnapshot> {
  const dbPath = path.join(rootDir, '.cgraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    await indexProject(rootDir, { force: false });
  }
  const db = await GraphDB.open(path.join(rootDir, '.cgraph', 'graph.db'));
  try {
    const dna = getCodebaseDNA(db);
    const stats = getProjectStats(db);
    return {
      label: 'current',
      created_at: new Date().toISOString(),
      root_dir: rootDir,
      summary: {
        total_files: stats.total_files,
        total_nodes: stats.total_nodes,
        total_edges: stats.total_edges,
        avg_fan_in: stats.avg_fan_in,
        avg_fan_out: stats.avg_fan_out,
      },
      health: {
        modularity: dna.health.modularity,
        dead_code: dna.health.dead_code,
        test_coverage: dna.health.test_coverage,
        complexity: dna.health.complexity,
        overall: dna.health.overall,
      },
      architecture: {
        style: dna.architecture_style,
        languages: dna.languages,
        roles: dna.role_distribution,
      },
    };
  } finally {
    db.close();
  }
}

export async function saveBaseline(rootDir: string, label: string): Promise<{ label: string; snapshot: ProjectHealthSnapshot }> {
  const history = readHistory(rootDir);
  const snapshot = await collectProjectSnapshot(rootDir);
  const trimmed = label.trim();
  const finalLabel = trimmed.length > 0 && trimmed !== 'latest'
    ? trimmed
    : `snapshot-${new Date().toISOString()}`;
  const entry = { ...snapshot, label: finalLabel };
  history.snapshots = [entry, ...history.snapshots.filter(s => s.label !== finalLabel)];
  writeHistory(rootDir, history);
  return { label: finalLabel, snapshot: entry };
}

export function listBaselines(rootDir: string): { total: number; snapshots: ProjectHealthSnapshot[] } {
  const history = readHistory(rootDir);
  const snapshots = [...history.snapshots].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { total: snapshots.length, snapshots };
}

export function compareBaselines(rootDir: string, fromLabel: string, toLabel: string): { from?: ProjectHealthSnapshot; to?: ProjectHealthSnapshot; deltas: Record<string, number> } {
  const history = readHistory(rootDir);
  const from = history.snapshots.find(s => s.label === fromLabel);
  const to = history.snapshots.find(s => s.label === toLabel);
  if (!from || !to) {
    if (!from && !to) {
      throw new Error(`Baselines not found: "${fromLabel}" and "${toLabel}"`);
    }
    if (!from) {
      throw new Error(`Baseline not found: "${fromLabel}"`);
    }
    throw new Error(`Baseline not found: "${toLabel}"`);
  }
  const deltas = {
    total_files: to.summary.total_files - from.summary.total_files,
    total_nodes: to.summary.total_nodes - from.summary.total_nodes,
    total_edges: to.summary.total_edges - from.summary.total_edges,
    overall_health: to.health.overall - from.health.overall,
    modularity: to.health.modularity - from.health.modularity,
    dead_code: to.health.dead_code - from.health.dead_code,
    test_coverage: to.health.test_coverage - from.health.test_coverage,
  };
  return { from, to, deltas };
}

export async function getTrend(rootDir: string): Promise<{ current: ProjectHealthSnapshot; baseline?: ProjectHealthSnapshot; deltas: Record<string, number> }> {
  const current = await collectProjectSnapshot(rootDir);
  const history = listBaselines(rootDir);
  const baseline = history.snapshots[0];
  if (!baseline) {
    return { current, deltas: {} };
  }
  const deltas = {
    total_files: current.summary.total_files - baseline.summary.total_files,
    total_nodes: current.summary.total_nodes - baseline.summary.total_nodes,
    total_edges: current.summary.total_edges - baseline.summary.total_edges,
    overall_health: current.health.overall - baseline.health.overall,
    modularity: current.health.modularity - baseline.health.modularity,
    dead_code: current.health.dead_code - baseline.health.dead_code,
    test_coverage: current.health.test_coverage - baseline.health.test_coverage,
  };
  return { current, baseline, deltas };
}
