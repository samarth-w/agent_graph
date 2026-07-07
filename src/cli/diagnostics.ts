import type { GraphDB } from '../storage';

export interface HealthCheck {
  name: string;
  passed: boolean;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

export interface DbHealthReport {
  ok: boolean;
  db_path: string;
  files: number;
  nodes: number;
  edges: number;
  repaired_count: number;
  checks: HealthCheck[];
  recommendations: string[];
}

export function inspectDbHealth(db: GraphDB, rootDir = '.'): DbHealthReport {
  const status = db.getStatus(rootDir);
  const files = db.getAllFiles();
  const nodes = db.getAllNodes();
  const edges = db.getAllEdges();
  const nodeIds = new Set(nodes.map(node => node.id));
  const orphanEdges = edges.filter(edge => !nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id));

  const checks: HealthCheck[] = [
    {
      name: 'schema',
      passed: true,
      detail: `Graph schema is available for ${files.length} file(s) and ${nodes.length} node(s).`,
      severity: 'info',
    },
    {
      name: 'connectivity',
      passed: orphanEdges.length === 0,
      detail: orphanEdges.length === 0
        ? 'All recorded edges point to known nodes.'
        : `${orphanEdges.length} edge(s) point to missing node(s).`,
      severity: orphanEdges.length === 0 ? 'info' : 'warning',
    },
  ];

  const recommendations: string[] = [];
  if (status.files_count === 0 && status.nodes_count === 0) {
    recommendations.push('Index a project to populate the graph database.');
  }
  if (orphanEdges.length > 0) {
    recommendations.push(`Repair ${orphanEdges.length} orphan edge(s) in the graph database.`);
  }

  return {
    ok: checks.every(check => check.passed) && recommendations.length === 0,
    db_path: status.db_path,
    files: files.length,
    nodes: nodes.length,
    edges: edges.length,
    repaired_count: 0,
    checks,
    recommendations,
  };
}

export function repairDbHealth(db: GraphDB, rootDir = '.'): DbHealthReport {
  const edges = db.getAllEdges();
  const nodes = db.getAllNodes();
  const nodeIds = new Set(nodes.map(node => node.id));
  const orphanEdges = edges.filter(edge => !nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id));

  for (const edge of orphanEdges) {
    db.deleteEdge(edge.id);
  }

  return {
    ...inspectDbHealth(db, rootDir),
    repaired_count: orphanEdges.length,
  };
}
