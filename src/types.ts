// ─── Symbol kinds ───────────────────────────────────────────────
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'module'
  | 'property'
  | 'field'
  | 'constant'
  | 'enum_member'
  | 'namespace'
  | 'route'
  | 'component'
  | 'struct'
  | 'trait';

// ─── Edge / relationship kinds ──────────────────────────────────
export type EdgeKind =
  | 'calls'
  | 'imports'
  | 'extends'
  | 'implements'
  | 'contains'
  | 'exports'
  | 'references'
  | 'authored'
  | 'instantiates'
  | 'decorates';

// ─── Role classification (inspired by optave/codegraph) ────────
export type SymbolRole =
  | 'entry'    // exported, no callers from within the project
  | 'core'     // high fan-in, many callers
  | 'utility'  // helper / shared function
  | 'dead'     // unreferenced, not exported
  | 'leaf';    // calls others but is not called

// ─── Database row types ────────────────────────────────────────
export interface FileRecord {
  id: number;
  path: string;
  hash: string;
  language: string;
  size: number;
  mtime: number;
  indexed_at: number;
}

export interface NodeRecord {
  id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null;
  exported: number; // 0 | 1
  role: string | null;
  /** Normalized semantic fingerprint of the symbol body. */
  fingerprint?: string | null;
  /** Normalization level actually applied when computing `fingerprint`. */
  fingerprint_level?: number | null;
}

export interface EdgeRecord {
  id: number;
  source_id: number;
  target_id: number;
  kind: string;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  est_cost_usd?: number;
}

export interface EdgeCost {
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  est_cost_usd?: number;
}

// ─── Parser output types ───────────────────────────────────────
export interface ParseResult {
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
  imports: ParsedImport[];
}

export interface ParsedSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string;
  doc: string | null;
  exported: boolean;
  children: ParsedSymbol[];
  extends?: string;
  implements?: string[];
  /** Normalized semantic fingerprint of the symbol body. */
  fingerprint?: string;
  /** Normalization level actually applied when computing `fingerprint`. */
  fingerprintLevel?: number;
}

export interface ParsedCall {
  callee: string;           // name of the called function/method
  receiver?: string;        // object receiver for method calls (e.g. "obj" in obj.foo())
  line: number;
  enclosingSymbol: string | null; // qualified name of enclosing function/class
}

export interface ParsedImport {
  source: string;           // module specifier ("./utils", "lodash", etc.)
  specifiers: ImportSpecifier[];
  line: number;
  isDynamic: boolean;
}

export interface ImportSpecifier {
  name: string;
  alias: string | null;
  isDefault: boolean;
  isNamespace: boolean;
}

// ─── Query / search results ───────────────────────────────────
export interface SearchResult {
  node: NodeRecord;
  file_path: string;
  rank: number;
}

export interface TraverseOptions {
  maxDepth: number;
  maxNodes: number;
  direction: 'forward' | 'backward' | 'both';
  edgeKinds?: EdgeKind[];
}

export interface TraverseResult {
  nodes: (NodeRecord & { file_path: string; depth: number })[];
  edges: EdgeRecord[];
  truncated: boolean;
}

export interface ImpactNodeFinding extends NodeRecord {
  file_path: string;
  depth: number;
  confidence: 'grounded' | 'likely' | 'speculative';
  relation_type: 'target' | 'calls' | 'imports' | 'condition' | 'copy' | 'heuristic';
  evidence_excerpt: string;
  rationale: string;
  evidence_file: string;
  evidence_line: number;
}

export interface ImpactScopeInfo {
  root_dir: string;
  indexed_roots: string[];
  indexed_files: number;
  indexed_nodes: number;
  indexed_edges: number;
  last_indexed: string | null;
  mode: 'discovery' | 'decision';
}

export interface ImpactResult {
  target: string;
  impacted_nodes: ImpactNodeFinding[];
  impacted_files: string[];
  edges: EdgeRecord[];
  truncated: boolean;
  scope: ImpactScopeInfo;
  warnings: string[];
}

export interface ImpactEvaluationCase {
  name: string;
  target: string;
  expected_symbols: string[];
  mode?: 'discovery' | 'decision';
}

export interface ImpactEvaluationCaseResult {
  name: string;
  target: string;
  passed: boolean;
  matched: string[];
  missing: string[];
  unexpected: string[];
  precision: number;
  recall: number;
  total_impacted: number;
}

export interface ImpactEvaluationSummary {
  total: number;
  passed: number;
  cases: ImpactEvaluationCaseResult[];
  precision: number;
  recall: number;
}

// ─── Context builder output ───────────────────────────────────
export interface ContextPayload {
  query: string;
  nodes: ContextNode[];
  edges: ContextEdge[];
  files: string[];
  snippets: Snippet[];
  stats: ContextStats;
}

export interface ContextNode {
  name: string;
  qualified_name: string;
  kind: string;
  role: string | null;
  file: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export interface ContextEdge {
  source: string;   // qualified_name
  target: string;   // qualified_name
  kind: string;
}

export interface Snippet {
  file: string;
  start_line: number;
  end_line: number;
  content: string;
}

export interface ContextStats {
  total_nodes: number;
  total_edges: number;
  total_files: number;
  estimated_tokens: number;
  /** 'high' = ≥2 FTS seeds matched; 'low' = weak or single-term match */
  confidence?: 'high' | 'low';
  /** edges / nodes ratio — proxy for context richness */
  edge_density?: number;
}

// ─── Status ────────────────────────────────────────────────────
export interface StatusInfo {
  db_path: string;
  exists: boolean;
  files_count: number;
  nodes_count: number;
  edges_count: number;
  last_indexed: string | null;
  languages: Record<string, number>;
  roles: Record<string, number>;
}

// ─── Config ────────────────────────────────────────────────────
export interface GraphConfig {
  maxDepth: number;
  maxNodes: number;
  maxSnippets: number;
  maxSnippetLines: number;
  ignorePaths: string[];
  extensions: string[];
  rules?: LintRule[];
  gate?: GateConfig;
  a2a?: A2AConfig;
  memory?: MemoryConfig;
}

export interface A2AConfig {
  trustMode?: 'registration_only' | 'per_write';
  maxVerifyLatencyMs?: number;
  allowVerifyFallback?: boolean;
  authToken?: string;
  maxBodyBytes?: number;
  registrationTtlMs?: number;
  rateLimitMaxRequests?: number;
  rateLimitWindowMs?: number;
}

export interface MemoryConfig {
  enabled?: boolean;
  requireEvidenceByDefault?: boolean;
  defaultRetentionMs?: number;
  allowUnverifiedWrites?: boolean;
  defaultDenyNamespaceAccess?: boolean;
  hybridRankingEnabled?: boolean;
  autoResolveConflicts?: boolean;
  autoResolveMinimumMargin?: number;
  /** Automatically run symbol-level provenance sync after a watcher re-index. */
  autoSyncProvenance?: boolean;
  /** Reverse call-graph hops walked from each changed symbol during auto-sync. */
  provenanceMaxDepth?: number;
  /**
   * Fingerprint normalization aggressiveness (0-4, or the level name).
   * Higher levels ignore more semantically-irrelevant edits.
   */
  fingerprintLevel?: number | string;
  replication?: MemoryReplicationConfig;
}

export interface MemoryReplicationConfig {
  enabled?: boolean;
  peerId?: string;
  peers?: string[];
  authToken?: string;
  timeoutMs?: number;
}

export interface MemoryMetrics {
  operations: Record<string, number>;
  openConflicts: number;
  activeVersions: number;
  expiredVersions: number;
  tombstonedRecords: number;
  rateLimitBuckets: number;
}

export interface MemoryObservability {
  operationLatencyMs: Record<string, { count: number; p50: number; p95: number; p99: number }>;
  alerts: Array<{ name: string; severity: 'warning' | 'critical'; value: number; threshold: number }>;
}

export interface GateConfig {
  maxCycles?: number;
  maxDeadSymbols?: number;
  minOverallHealth?: number;
  maxRiskScore?: number;
  requireAffectedTests?: boolean;
}

// ─── Trace (path finding) ──────────────────────────────────────
export interface TraceResult {
  from: string;
  to: string;
  found: boolean;
  hops: TraceHop[];
  total_hops: number;
}

export interface TraceHop {
  name: string;
  qualified_name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  edge_kind: string | null; // null for the first node
  code?: string;
}

// ─── Explore (multi-symbol deep dive) ──────────────────────────
export interface ExploreResult {
  query: string;
  files: ExploreFileGroup[];
  relationships: ExploreRelationship[];
  stats: { total_symbols: number; total_files: number; estimated_tokens: number };
}

export interface ExploreFileGroup {
  file: string;
  language: string;
  symbols: { name: string; kind: string; line: number }[];
  source: string;
}

export interface ExploreRelationship {
  source: string;
  target: string;
  kind: string;
}

// ─── Node detail ───────────────────────────────────────────────
export interface NodeDetail {
  name: string;
  qualified_name: string;
  kind: string;
  role: string | null;
  file: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null;
  exported: boolean;
  code?: string;
  trail: {
    callers: TrailEntry[];
    callees: TrailEntry[];
  };
}

export interface TrailEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
}

// ─── Files listing ─────────────────────────────────────────────
export interface FileInfo {
  path: string;
  language: string;
  symbol_count: number;
}

// ─── Affected (test impact) ────────────────────────────────────
export interface AffectedResult {
  changed_files: string[];
  affected_tests: string[];
  total_affected: number;
  depth: number;
}

// ─── MCP types ─────────────────────────────────────────────────
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      default?: unknown;
    }>;
    required?: string[];
  };
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ─── A2A adapter types ─────────────────────────────────────────
export interface A2AAgentCard {
  name: string;
  version: string;
  transport: 'http+jsonrpc';
  capabilities: Array<{ name: string; implemented: boolean; description: string }>;
}

export interface A2ARpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2ARpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Persistent memory types ──────────────────────────────────
export type MemoryType = 'fact' | 'plan' | 'observation' | 'decision' | 'warning';
export type MemoryStatus = 'active' | 'unverified' | 'superseded' | 'revoked' | 'expired' | 'tombstoned' | 'stale' | 'needs_revalidation' | 'contradicted';

export interface MemoryEvidenceInput {
  sourceType: string;
  sourceRef: string;
  excerptHash?: string;
  capturedAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryPrincipalSnapshot {
  principalId: string;
  trustTier: string;
  status: MemoryStatus;
  expiresAtMs?: number;
  revokedAtMs?: number;
  metadata: Record<string, unknown>;
}

export interface MemoryWriteInput {
  principalId: string;
  namespace: string;
  subjectKey: string;
  memoryType?: MemoryType;
  payload: Record<string, unknown>;
  confidence?: number;
  evidence?: MemoryEvidenceInput[];
  validFromMs?: number;
  validToMs?: number;
  memoryId?: string;
  versionId?: string;
  idempotencyKey?: string;
}

export interface MemoryWriteResult {
  ok: boolean;
  memoryId?: string;
  versionId?: string;
  status?: MemoryStatus;
  error?: string;
}

export interface MemoryQueryInput {
  namespace: string;
  subjectKey: string;
  memoryType?: MemoryType;
  limit?: number;
  nowMs?: number;
  principalId?: string;
  requireEvidence?: boolean;
  includeExpired?: boolean;
  includeSuperseded?: boolean;
  semanticQuery?: string;
}

export interface MemoryScoreComponents {
  trust: number;
  recency: number;
  confidence: number;
  evidence: number;
  penalty: number;
  semantic?: number;
  adaptive?: number;
}

export interface MemoryQueryEntry {
  memoryId: string;
  versionId: string;
  namespace: string;
  subjectKey: string;
  memoryType: MemoryType;
  payload: Record<string, unknown>;
  confidence: number;
  status: MemoryStatus;
  score: number;
  scoreComponents: MemoryScoreComponents;
  evidenceCount: number;
  createdAt: number;
  policyWarnings: string[];
  acceptedRules: string[];
  evidenceRefs: Array<{ sourceType: string; sourceRef: string; excerptHash?: string; metadata?: Record<string, unknown> }>;
}

export interface MemoryQueryResult {
  results: MemoryQueryEntry[];
  total: number;
}

export interface MemoryPrincipalInput {
  principalId: string;
  trustTier?: string;
  expiresAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryRevocationInput {
  principalId: string;
  reason?: string;
  nowMs?: number;
}

export interface MemoryConflictResult {
  conflictId: string;
  resolutionState: 'open' | 'winner_selected' | 'unresolved';
}

export interface MemoryConflict {
  conflictId: string;
  leftVersionId: string;
  rightVersionId: string;
  conflictType: string;
  resolutionState: 'open' | 'winner_selected' | 'unresolved';
  winnerVersionId?: string;
  createdAt: number;
}

export interface MemoryAutoResolutionResult {
  resolvedCount: number;
  unresolvedCount: number;
  conflictIds: string[];
}

export interface MemoryInvalidationInput {
  sourceType?: string;
  sourceRef?: string;
  sourceHash?: string;
  reason?: string;
  nowMs?: number;
}

export interface MemoryInvalidationResult {
  invalidatedCount: number;
  versionIds: string[];
}

// ─── Symbol-level provenance ───────────────────────────────────
export interface SymbolFingerprint {
  qualifiedName: string;
  filePath: string;
  fingerprint: string;
}

export interface ProvenanceDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

export type ProvenanceChangeType = 'changed' | 'removed' | 'dependent';

export interface ProvenanceImpactedSymbol {
  qualifiedName: string;
  filePath: string;
  changeType: ProvenanceChangeType;
  depth: number;
}

export interface ProvenanceSyncResult {
  scannedSymbols: number;
  changedSymbols: string[];
  addedSymbols: string[];
  removedSymbols: string[];
  impactedSymbols: ProvenanceImpactedSymbol[];
  invalidatedCount: number;
  invalidatedVersionIds: string[];
  durationMs: number;
  dryRun: boolean;
  /**
   * True when the stored baseline was produced by a different fingerprint
   * algorithm or normalization level and could not be compared, forcing a
   * conservative full revalidation.
   */
  baselineReset: boolean;
  /** `<algorithmVersion>:<fingerprintLevel>` that produced this baseline. */
  baselineVersion: string;
}

export interface MemoryChangeImpactEntry {
  memoryId: string;
  versionId: string;
  namespace: string;
  subjectKey: string;
  memoryType: MemoryType;
  status: MemoryStatus;
  reason?: string | null;
  evidenceRefs: Array<{ sourceType: string; sourceRef: string; metadata?: Record<string, unknown> }>;
}

export interface MemoryChangeImpactResult {
  affectedCount: number;
  affected: MemoryChangeImpactEntry[];
}

export interface MemoryRevalidationInput {
  versionId: string;
  reason?: string;
  nowMs?: number;
}

export interface MemoryRevalidationResult {
  ok: boolean;
  versionId: string;
  status: MemoryStatus;
  reason?: string | null;
  error?: string;
}

export interface MemoryReplicationResult {
  attempted: number;
  acknowledged: number;
  failedPeers: string[];
}

export interface MemoryExpiryResult {
  expiredCount: number;
}

export interface MemoryCompactionResult {
  tombstonedCount: number;
}

export interface MemoryBackfillResult {
  totalLegacyNodes?: number;
  importedCount: number;
  skippedCount: number;
  parityMismatches?: number;
}

export interface MemoryMigrationReport {
  totalLegacyNodes: number;
  importedLegacyRecords: number;
  skippedLegacyRecords: number;
  parityMismatches: number;
}

// ─── Parsed search query (field-qualified) ─────────────────────
export interface ParsedQuery {
  terms: string[];
  kind?: string;
  file?: string;
  lang?: string;
  name?: string;
  role?: string;
  exported?: boolean;
}

// ─── Framework route ───────────────────────────────────────────
export interface ParsedRoute {
  method: string;        // GET, POST, etc. or '*' for all
  pattern: string;       // URL pattern e.g. '/api/users/:id'
  handler: string;       // handler function/class name
  line: number;
  framework: string;     // express, react-router, django, flask, fastapi, nextjs
}

// ─── Auto Context (warm-start file awareness) ──────────────────
export interface AutoContextResult {
  file: string;
  language: string;
  symbols: AutoContextSymbol[];
  related_tests: string[];
  imports_from: string[];
  imported_by: string[];
  stats: { total: number; exported: number; roles: Record<string, number> };
}

export interface AutoContextSymbol {
  name: string;
  kind: string;
  role: string | null;
  line: number;
  exported: boolean;
  callers: { name: string; file: string }[];
  callees: { name: string; file: string }[];
}

// ─── Intent Search (BM25) ──────────────────────────────────────
export interface IntentSearchResult {
  results: IntentMatch[];
  total: number;
  query_terms: string[];
}

export interface IntentMatch {
  name: string;
  qualified_name: string;
  kind: string;
  file: string;
  line: number;
  signature: string | null;
  score: number;
  matched_terms: string[];
}

// ─── Plan Validation (change risk assessment) ──────────────────
export interface PlanValidation {
  targets: string[];
  risk_level: 'low' | 'medium' | 'high';
  risk_score: number;
  impacted_symbols: { name: string; file: string; depth: number }[];
  impacted_files: string[];
  affected_tests: string[];
  warnings: string[];
  cycle_risks: string[];
}

// ─── Architecture Lint ─────────────────────────────────────────
export interface LintRule {
  type: 'deny-dependency' | 'max-fan-out' | 'no-cycles' | 'max-file-symbols';
  from?: string;
  to?: string;
  max?: number;
  scope?: string;
  severity: 'error' | 'warn';
  message?: string;
}

export interface LintViolation {
  rule: LintRule;
  symbol?: string;
  file?: string;
  detail: string;
}

export interface LintResult {
  passed: boolean;
  violations: LintViolation[];
  errors: number;
  warnings: number;
  summary: string;
}

// ─── Codebase DNA (fingerprint) ────────────────────────────────
export interface CodebaseDNA {
  languages: { lang: string; files: number; percentage: number }[];
  frameworks: string[];
  architecture_style: string;
  health: {
    modularity: number;
    dead_code: number;
    test_coverage: number;
    complexity: number;
    overall: number;
  };
  size: { files: number; symbols: number; edges: number };
  role_distribution: Record<string, number>;
  key_hubs: { name: string; file: string; fan_in: number; fan_out: number }[];
  summary: string;
}
