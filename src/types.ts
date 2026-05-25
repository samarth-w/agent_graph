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
}

export interface EdgeRecord {
  id: number;
  source_id: number;
  target_id: number;
  kind: string;
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
