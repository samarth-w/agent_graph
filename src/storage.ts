/**
 * SQLite graph storage via sql.js (pure JS / WASM - zero native deps).
 *
 * sql.js keeps the DB in memory and writes to disk on save().
 * The GraphDB.open() factory is async because sql.js needs to load WASM.
 */
import crypto from 'crypto';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import type {
  FileRecord, NodeRecord, EdgeRecord, SearchResult, StatusInfo, EdgeCost,
  MemoryBackfillResult, MemoryCompactionResult, MemoryConflict, MemoryConflictResult, MemoryExpiryResult, MemoryPrincipalSnapshot,
  MemoryQueryEntry, MemoryQueryInput, MemoryQueryResult, MemoryStatus, MemoryType,
  MemoryWriteInput, MemoryWriteResult,
} from './types';

// --- Schema ---------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT    UNIQUE NOT NULL,
  hash       TEXT    NOT NULL,
  language   TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  mtime      REAL    NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id        INTEGER NOT NULL REFERENCES files(id),
  name           TEXT    NOT NULL,
  qualified_name TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  signature      TEXT,
  doc            TEXT,
  exported       INTEGER NOT NULL DEFAULT 0,
  role           TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_file_qname
  ON nodes(file_id, qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role);

CREATE TABLE IF NOT EXISTS edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES nodes(id),
  target_id INTEGER NOT NULL REFERENCES nodes(id),
  kind      TEXT    NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON edges(source_id, target_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

CREATE TABLE IF NOT EXISTS raw_refs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      INTEGER NOT NULL REFERENCES files(id),
  kind         TEXT    NOT NULL,
  source_qname TEXT,
  target_name  TEXT    NOT NULL,
  target_module TEXT,
  receiver     TEXT,
  line         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rawrefs_file ON raw_refs(file_id);
CREATE INDEX IF NOT EXISTS idx_rawrefs_target ON raw_refs(target_name);

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  trust_tier TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES principals(principal_id)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  version_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_ref_count INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  supersedes_version_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_records(memory_id)
);

CREATE TABLE IF NOT EXISTS memory_evidence (
  evidence_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt_hash TEXT,
  captured_at INTEGER NOT NULL,
  FOREIGN KEY (version_id) REFERENCES memory_versions(version_id)
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  conflict_id TEXT PRIMARY KEY,
  left_version_id TEXT NOT NULL,
  right_version_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  resolution_state TEXT NOT NULL,
  winner_version_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_access_log (
  access_id TEXT PRIMARY KEY,
  principal_id TEXT,
  operation TEXT NOT NULL,
  request_fingerprint TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_subject
  ON memory_records(namespace, subject_key, status);
CREATE INDEX IF NOT EXISTS idx_versions_memory_time
  ON memory_versions(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ccr_cache (
  id            TEXT PRIMARY KEY,
  original_data TEXT NOT NULL,
  timestamp     INTEGER NOT NULL
);
`;

// --- Singleton WASM loader ------------------------------------------
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
const CCR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  trust_tier TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES principals(principal_id)
);

CREATE TABLE IF NOT EXISTS memory_versions (
  version_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_ref_count INTEGER NOT NULL DEFAULT 0,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  supersedes_version_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_records(memory_id)
);

CREATE TABLE IF NOT EXISTS memory_evidence (
  evidence_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt_hash TEXT,
  captured_at INTEGER NOT NULL,
  FOREIGN KEY (version_id) REFERENCES memory_versions(version_id)
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  conflict_id TEXT PRIMARY KEY,
  left_version_id TEXT NOT NULL,
  right_version_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  resolution_state TEXT NOT NULL,
  winner_version_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_access_log (
  access_id TEXT PRIMARY KEY,
  principal_id TEXT,
  operation TEXT NOT NULL,
  request_fingerprint TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_subject
  ON memory_records(namespace, subject_key, status);
CREATE INDEX IF NOT EXISTS idx_versions_memory_time
  ON memory_versions(memory_id, created_at DESC);
`;
const sharedDbInstances = new Map<string, any>();
const sharedDbPromises = new Map<string, Promise<any>>();
function loadSql() {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

// --- DB wrapper -----------------------------------------------------

/** Tokenize text for inverted index: camelCase split, snake_case split, lowercase */
function indexTokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:\\(){}[\]<>,;'"=+*#@!?|&^~`$%]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

export class GraphDB {
  private db: SqlJsDatabase;
  readonly dbPath: string;

  /** Inverted index: token → Set<nodeId> */
  private invertedIndex: Map<string, Set<number>> | null = null;
  /** Forward index: nodeId → { node, filePath, tokens } */
  private indexedDocs: Map<number, { node: NodeRecord; filePath: string; tokens: string[] }> | null = null;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** Async factory - use instead of `new`. */
  static async open(dbPath: string): Promise<GraphDB> {
    const normalizedPath = path.resolve(dbPath);
    const existing = sharedDbInstances.get(normalizedPath);
    if (existing) return existing;

    const pending = sharedDbPromises.get(normalizedPath);
    if (pending) return pending;

    const promise = (async () => {
      const dir = path.dirname(normalizedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const SQL = await loadSql();
      let db: SqlJsDatabase;
      if (fs.existsSync(normalizedPath)) {
        const buf = fs.readFileSync(normalizedPath);
        db = new SQL.Database(buf);
      } else {
        db = new SQL.Database();
      }

      db.run('PRAGMA foreign_keys = ON');
      const instance = new GraphDB(db, normalizedPath);
      instance.exec(SCHEMA);
      instance.ensureMigrations();
      sharedDbInstances.set(normalizedPath, instance);
      return instance;
    })();

    sharedDbPromises.set(normalizedPath, promise);
    try {
      return await promise;
    } finally {
      sharedDbPromises.delete(normalizedPath);
    }
  }

  private ensureMigrations(): void {
    this.ensureEdgeCostColumns();
    this.exec(MEMORY_SCHEMA);
  }

  private ensureEdgeCostColumns(): void {
    const cols = this.all('PRAGMA table_info(edges)');
    const names = new Set(cols.map((c: any) => String(c.name)));
    if (!names.has('tokens_in')) {
      this.exec('ALTER TABLE edges ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('tokens_out')) {
      this.exec('ALTER TABLE edges ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('latency_ms')) {
      this.exec('ALTER TABLE edges ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0');
    }
    if (!names.has('est_cost_usd')) {
      this.exec('ALTER TABLE edges ADD COLUMN est_cost_usd REAL NOT NULL DEFAULT 0');
    }
  }

  // -- low-level helpers (mimic better-sqlite3 feel) ----------------
  private exec(sql: string): void {
    this.db.exec(sql);
  }

  private run(sql: string, params: any[] = []): number {
    this.db.run(sql, params);
    const row = this.db.exec('SELECT last_insert_rowid() as id');
    return (row[0]?.values[0]?.[0] as number) ?? 0;
  }

  private get(sql: string, params: any[] = []): any | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const obj = stmt.getAsObject();
      stmt.free();
      return obj;
    }
    stmt.free();
    return undefined;
  }

  private all(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // -- persistence ---------------------------------------------------
  save(): void {
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const temporaryPath = `${this.dbPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, Buffer.from(data));
      fs.renameSync(temporaryPath, this.dbPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }

  // -- transactions --------------------------------------------------
  transaction<T>(fn: () => T): T {
    this.exec('BEGIN');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (err) {
      this.exec('ROLLBACK');
      throw err;
    }
  }

  // -- file ops ------------------------------------------------------
  upsertFile(
    filePath: string, hash: string, language: string,
    size: number, mtime: number, force?: boolean,
  ): { id: number; changed: boolean } {
    const existing = this.get(
      'SELECT id, hash FROM files WHERE path = ?', [filePath],
    ) as { id: number; hash: string } | undefined;

    if (existing) {
      if (existing.hash === hash && !force) return { id: existing.id, changed: false };
      this.purgeFileData(existing.id);
      this.run(
        'UPDATE files SET hash=?, language=?, size=?, mtime=?, indexed_at=? WHERE id=?',
        [hash, language, size, mtime, Date.now(), existing.id],
      );
      return { id: existing.id, changed: true };
    }

    const id = this.run(
      'INSERT INTO files (path,hash,language,size,mtime,indexed_at) VALUES (?,?,?,?,?,?)',
      [filePath, hash, language, size, mtime, Date.now()],
    );
    return { id, changed: true };
  }

  getFile(filePath: string): FileRecord | undefined {
    return this.get('SELECT * FROM files WHERE path = ?', [filePath]);
  }

  getFileById(id: number): FileRecord | undefined {
    return this.get('SELECT * FROM files WHERE id = ?', [id]);
  }

  getAllFiles(): FileRecord[] {
    return this.all('SELECT * FROM files');
  }

  removeStaleFiles(knownPaths: Set<string>): number {
    const allFiles = this.getAllFiles();
    let removed = 0;
    for (const f of allFiles) {
      if (!knownPaths.has(f.path)) {
        this.purgeFileData(f.id);
        this.run('DELETE FROM files WHERE id = ?', [f.id]);
        removed++;
      }
    }
    return removed;
  }

  private purgeFileData(fileId: number): void {
    this.run(
      `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file_id = ?)
         OR target_id IN (SELECT id FROM nodes WHERE file_id = ?)`,
      [fileId, fileId],
    );
    this.run('DELETE FROM nodes WHERE file_id = ?', [fileId]);
    this.run('DELETE FROM raw_refs WHERE file_id = ?', [fileId]);
    this.invalidateIndex();
  }

  /** Invalidate the in-memory inverted index (call after data mutations) */
  invalidateIndex(): void {
    this.invertedIndex = null;
    this.indexedDocs = null;
  }

  /** Lazily build the inverted index from all nodes */
  private ensureIndex(): void {
    if (this.invertedIndex) return;
    this.invertedIndex = new Map();
    this.indexedDocs = new Map();

    const rows = this.all(
      `SELECT n.*, f.path AS file_path FROM nodes n JOIN files f ON f.id = n.file_id`,
      [],
    );

    for (const row of rows) {
      const node: NodeRecord = {
        id: row.id, file_id: row.file_id, name: row.name,
        qualified_name: row.qualified_name, kind: row.kind,
        start_line: row.start_line, end_line: row.end_line,
        signature: row.signature, doc: row.doc,
        exported: row.exported, role: row.role,
      };
      const text = [node.name, node.qualified_name, node.signature ?? '', node.doc ?? ''].join(' ');
      const tokens = indexTokenize(text);
      this.indexedDocs.set(node.id, { node, filePath: row.file_path as string, tokens });

      for (const token of tokens) {
        let set = this.invertedIndex.get(token);
        if (!set) { set = new Set(); this.invertedIndex.set(token, set); }
        set.add(node.id);
      }
    }
  }

  // -- node ops ------------------------------------------------------
  insertNode(
    fileId: number, name: string, qualifiedName: string, kind: string,
    startLine: number, endLine: number,
    signature: string | null, doc: string | null,
    exported: boolean,
  ): number {
    this.run(
      'DELETE FROM nodes WHERE file_id = ? AND qualified_name = ?',
      [fileId, qualifiedName],
    );
    this.invalidateIndex();
    return this.run(
      `INSERT INTO nodes
        (file_id,name,qualified_name,kind,start_line,end_line,signature,doc,exported)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [fileId, name, qualifiedName, kind, startLine, endLine,
       signature, doc, exported ? 1 : 0],
    );
  }

  getNode(id: number): NodeRecord | undefined {
    return this.get('SELECT * FROM nodes WHERE id = ?', [id]);
  }

  findNodesByName(name: string): NodeRecord[] {
    return this.all('SELECT * FROM nodes WHERE name = ?', [name]);
  }

  findNodeByQName(qname: string): NodeRecord | undefined {
    return this.get('SELECT * FROM nodes WHERE qualified_name = ?', [qname]);
  }

  getNodesForFile(fileId: number): NodeRecord[] {
    return this.all(
      'SELECT * FROM nodes WHERE file_id = ? ORDER BY start_line', [fileId],
    );
  }

  getAllNodes(): NodeRecord[] {
    return this.all('SELECT * FROM nodes');
  }

  updateRole(nodeId: number, role: string): void {
    this.run('UPDATE nodes SET role = ? WHERE id = ?', [role, nodeId]);
  }

  // -- raw_refs ops --------------------------------------------------
  insertRawRef(
    fileId: number, kind: string, sourceQName: string | null,
    targetName: string, targetModule: string | null,
    receiver: string | null, line: number,
  ): void {
    this.run(
      `INSERT INTO raw_refs (file_id,kind,source_qname,target_name,target_module,receiver,line)
       VALUES (?,?,?,?,?,?,?)`,
      [fileId, kind, sourceQName, targetName, targetModule, receiver, line],
    );
  }

  getAllRawRefs(): {
    file_id: number; kind: string; source_qname: string | null;
    target_name: string; target_module: string | null;
    receiver: string | null; line: number;
  }[] {
    return this.all('SELECT * FROM raw_refs');
  }

  // -- edge ops ------------------------------------------------------
  insertEdge(sourceId: number, targetId: number, kind: string, cost: EdgeCost = {}): void {
    const existing = this.get(
      'SELECT id FROM edges WHERE source_id=? AND target_id=? AND kind=?',
      [sourceId, targetId, kind],
    );
    if (!existing) {
      const edgeCost = {
        tokens_in: typeof cost.tokens_in === 'number' ? cost.tokens_in : 0,
        tokens_out: typeof cost.tokens_out === 'number' ? cost.tokens_out : 0,
        latency_ms: typeof cost.latency_ms === 'number' ? cost.latency_ms : 0,
        est_cost_usd: typeof cost.est_cost_usd === 'number' ? cost.est_cost_usd : 0,
      };
      this.run(
        'INSERT INTO edges (source_id,target_id,kind,tokens_in,tokens_out,latency_ms,est_cost_usd) VALUES (?,?,?,?,?,?,?)',
        [sourceId, targetId, kind, edgeCost.tokens_in, edgeCost.tokens_out, edgeCost.latency_ms, edgeCost.est_cost_usd],
      );
    }
  }

  deleteEdge(edgeId: number): void {
    this.run('DELETE FROM edges WHERE id = ?', [edgeId]);
  }

  clearAllEdges(): void {
    this.run('DELETE FROM edges');
  }

  /** Clear edges where source or target belongs to any of the given file IDs. */
  clearEdgesForFiles(fileIds: number[]): void {
    if (fileIds.length === 0) return;
    const placeholders = fileIds.map(() => '?').join(',');
    this.run(
      `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file_id IN (${placeholders}))
       OR target_id IN (SELECT id FROM nodes WHERE file_id IN (${placeholders}))`,
      [...fileIds, ...fileIds],
    );
  }

  getEdgesFrom(nodeId: number, kind?: string): EdgeRecord[] {
    if (kind) {
      return this.all(
        'SELECT * FROM edges WHERE source_id = ? AND kind = ?', [nodeId, kind],
      );
    }
    return this.all('SELECT * FROM edges WHERE source_id = ?', [nodeId]);
  }

  getEdgesTo(nodeId: number, kind?: string): EdgeRecord[] {
    if (kind) {
      return this.all(
        'SELECT * FROM edges WHERE target_id = ? AND kind = ?', [nodeId, kind],
      );
    }
    return this.all('SELECT * FROM edges WHERE target_id = ?', [nodeId]);
  }

  getAllEdges(): EdgeRecord[] {
    return this.all('SELECT * FROM edges');
  }

  // -- batch helpers (avoid N+1 queries) ----------------------------

  /** Build a Map<fileId, FileRecord> for O(1) file lookups. */
  getFileMap(): Map<number, FileRecord> {
    const files = this.getAllFiles();
    return new Map(files.map(f => [f.id, f]));
  }

  /** Build a Map<nodeId, NodeRecord> for O(1) node lookups. */
  getNodeMap(): Map<number, NodeRecord> {
    const nodes = this.getAllNodes();
    return new Map(nodes.map(n => [n.id, n]));
  }

  /** Build adjacency lists from all edges in two bulk queries.
   *  Returns { outgoing: Map<sourceId, EdgeRecord[]>, incoming: Map<targetId, EdgeRecord[]> }
   */
  getAdjacencyMaps(kind?: string): { outgoing: Map<number, EdgeRecord[]>; incoming: Map<number, EdgeRecord[]> } {
    const edges = kind
      ? this.all('SELECT * FROM edges WHERE kind = ?', [kind])
      : this.getAllEdges();
    const outgoing = new Map<number, EdgeRecord[]>();
    const incoming = new Map<number, EdgeRecord[]>();
    for (const e of edges) {
      let out = outgoing.get(e.source_id);
      if (!out) { out = []; outgoing.set(e.source_id, out); }
      out.push(e);
      let inc = incoming.get(e.target_id);
      if (!inc) { inc = []; incoming.set(e.target_id, inc); }
      inc.push(e);
    }
    return { outgoing, incoming };
  }

  /** Get candidate node IDs from inverted index for given tokens (union of postings) */
  getInvertedCandidates(tokens: string[]): number[] {
    this.ensureIndex();
    const idx = this.invertedIndex!;
    const candidates = new Set<number>();
    for (const t of tokens) {
      const tl = t.toLowerCase();
      const exact = idx.get(tl);
      if (exact) for (const id of exact) candidates.add(id);
      // Prefix match for short tokens
      if (tl.length <= 4) {
        for (const [token, ids] of idx) {
          if (token.startsWith(tl) && token !== tl) {
            for (const id of ids) candidates.add(id);
          }
        }
      }
    }
    return [...candidates];
  }

  // -- keyword search (inverted index, ranked) ------------------------
  ftsSearch(query: string, limit = 20): SearchResult[] {
    const rawTerms = query.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 0);
    if (rawTerms.length === 0) return [];

    // Also tokenize with camelCase/snake_case splitting for index compatibility
    const terms = new Set<string>();
    for (const t of rawTerms) {
      terms.add(t.toLowerCase());
      for (const sub of indexTokenize(t)) terms.add(sub);
    }
    const termArr = [...terms].filter(t => t.length > 0);
    if (termArr.length === 0) return [];

    this.ensureIndex();
    const idx = this.invertedIndex!;
    const docs = this.indexedDocs!;

    // Collect candidate node IDs — union of all term postings
    const candidates = new Set<number>();
    for (const t of termArr) {
      // Exact token match
      const exact = idx.get(t);
      if (exact) for (const id of exact) candidates.add(id);
      // Prefix match for short queries (≤ 4 chars)
      if (t.length <= 4) {
        for (const [token, ids] of idx) {
          if (token.startsWith(t) && token !== t) {
            for (const id of ids) candidates.add(id);
          }
        }
      }
    }

    if (candidates.size === 0) return [];

    // Score candidates: exact name > prefix > contains; more terms > fewer; exported boost
    const results: SearchResult[] = [];
    for (const id of candidates) {
      const doc = docs.get(id);
      if (!doc) continue;

      let score = 0;
      const nameLower = doc.node.name.toLowerCase();
      const qnameLower = (doc.node.qualified_name || '').toLowerCase();
      const sigLower = (doc.node.signature || '').toLowerCase();
      const docLower = (doc.node.doc || '').toLowerCase();
      // Score using original raw terms (not sub-tokens) for relevance
      const scoringTerms = rawTerms.map(t => t.toLowerCase());
      for (const tl of scoringTerms) {
        if (nameLower === tl) score += 100;
        else if (nameLower.startsWith(tl)) score += 50;
        else if (nameLower.includes(tl)) score += 20;
        else if (qnameLower.includes(tl) || sigLower.includes(tl) || docLower.includes(tl)) score += 5;
      }
      if (doc.node.exported) score += 10;
      if (score > 0) {
        results.push({ node: doc.node, file_path: doc.filePath, rank: -score });
      }
    }

    return results.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }

  /**
   * Fuzzy search using trigram similarity and Levenshtein distance.
   * Useful when exact/substring matching returns too few results.
   */
  fuzzySearch(query: string, limit = 20, threshold = 0.3): SearchResult[] {
    const q = query.toLowerCase().trim();
    if (q.length === 0) return [];

    const qTrigrams = trigrams(q);
    if (qTrigrams.size === 0) return [];

    // Fetch all node names (lightweight — only what we need for scoring)
    const rows = this.all(
      `SELECT n.*, f.path AS file_path FROM nodes n JOIN files f ON f.id = n.file_id`,
      [],
    );

    const results: SearchResult[] = [];
    for (const row of rows) {
      const name = (row.name as string).toLowerCase();
      const sim = trigramSimilarity(qTrigrams, trigrams(name));
      if (sim < threshold) continue;

      // Combine trigram similarity with Levenshtein distance for ranking
      const lev = levenshtein(q, name);
      const maxLen = Math.max(q.length, name.length);
      const levScore = 1 - lev / maxLen; // 1 = identical, 0 = completely different
      const combined = sim * 0.6 + levScore * 0.4;

      results.push({
        node: {
          id: row.id, file_id: row.file_id, name: row.name,
          qualified_name: row.qualified_name, kind: row.kind,
          start_line: row.start_line, end_line: row.end_line,
          signature: row.signature, doc: row.doc,
          exported: row.exported, role: row.role,
        },
        file_path: row.file_path as string,
        rank: -combined,
      });
    }

    return results.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }

  // -- stats ---------------------------------------------------------
  getStatus(rootDir: string): StatusInfo {
    const cnt = (sql: string) => {
      const r = this.get(sql);
      return (r?.c as number) ?? 0;
    };

    const filesCount = cnt('SELECT count(*) as c FROM files');
    const nodesCount = cnt('SELECT count(*) as c FROM nodes');
    const edgesCount = cnt('SELECT count(*) as c FROM edges');

    const lastRow = this.get('SELECT max(indexed_at) as v FROM files');
    const lastIndexed = lastRow?.v
      ? new Date(lastRow.v as number).toISOString() : null;

    const langs: Record<string, number> = {};
    for (const r of this.all(
      'SELECT language, count(*) as c FROM files GROUP BY language',
    )) {
      langs[r.language] = r.c;
    }

    const roles: Record<string, number> = {};
    for (const r of this.all(
      'SELECT role, count(*) as c FROM nodes WHERE role IS NOT NULL GROUP BY role',
    )) {
      roles[r.role] = r.c;
    }

    return {
      db_path: this.dbPath,
      exists: true,
      files_count: filesCount,
      nodes_count: nodesCount,
      edges_count: edgesCount,
      last_indexed: lastIndexed,
      languages: langs,
      roles,
    };
  }

  // -- metadata ------------------------------------------------------
  setMeta(key: string, value: string): void {
    this.run('DELETE FROM metadata WHERE key = ?', [key]);
    this.run('INSERT INTO metadata (key,value) VALUES (?,?)', [key, value]);
  }

  getMeta(key: string): string | undefined {
    const row = this.get('SELECT value FROM metadata WHERE key = ?', [key]);
    return row?.value as string | undefined;
  }

  saveCCR(id: string, originalData: string, timestamp: number): void {
    this.cleanupOldCCR(CCR_MAX_AGE_MS, timestamp);
    this.run(
      'INSERT OR REPLACE INTO ccr_cache (id, original_data, timestamp) VALUES (?, ?, ?)',
      [id, originalData, timestamp],
    );
  }

  getCCR(id: string): string | undefined {
    const row = this.get('SELECT original_data FROM ccr_cache WHERE id = ?', [id]);
    return row?.original_data as string | undefined;
  }

  cleanupOldCCR(maxAgeMs: number, now = Date.now()): void {
    const cutoff = now - maxAgeMs;
    this.run('DELETE FROM ccr_cache WHERE timestamp < ?', [cutoff]);
  }

  registerPrincipal(input: { principalId: string; trustTier?: string; expiresAtMs?: number; metadata?: Record<string, unknown> }): MemoryPrincipalSnapshot {
    const principalId = input.principalId;
    const trustTier = input.trustTier ?? 'neutral';
    const expiresAtMs = typeof input.expiresAtMs === 'number' ? input.expiresAtMs : undefined;
    const metadataJson = JSON.stringify(input.metadata ?? {});
    const now = Date.now();
    const status: MemoryStatus = expiresAtMs && expiresAtMs <= now ? 'expired' : 'active';
    this.run('DELETE FROM principals WHERE principal_id = ?', [principalId]);
    this.run(
      'INSERT INTO principals (principal_id, trust_tier, status, expires_at, revoked_at, metadata_json) VALUES (?,?,?,?,?,?)',
      [principalId, trustTier, status, expiresAtMs ?? null, null, metadataJson],
    );
    return {
      principalId,
      trustTier,
      status,
      expiresAtMs,
      metadata: input.metadata ?? {},
    };
  }

  revokePrincipal(input: { principalId: string; reason?: string; nowMs?: number }): MemoryPrincipalSnapshot {
    const principalId = input.principalId;
    const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    const existing = this.get('SELECT * FROM principals WHERE principal_id = ?', [principalId]) as any | undefined;
    const metadataJson = JSON.stringify({
      ...(existing?.metadata_json ? JSON.parse(existing.metadata_json as string) : {}),
      reason: input.reason ?? 'revoked',
    });
    this.run('DELETE FROM principals WHERE principal_id = ?', [principalId]);
    this.run(
      'INSERT INTO principals (principal_id, trust_tier, status, expires_at, revoked_at, metadata_json) VALUES (?,?,?,?,?,?)',
      [principalId, existing?.trust_tier ?? 'neutral', 'revoked', existing?.expires_at ?? null, nowMs, metadataJson],
    );
    return {
      principalId,
      trustTier: existing?.trust_tier ?? 'neutral',
      status: 'revoked',
      expiresAtMs: existing?.expires_at ? Number(existing.expires_at) : undefined,
      revokedAtMs: nowMs,
      metadata: { reason: input.reason ?? 'revoked' },
    };
  }

  writeMemory(input: MemoryWriteInput): MemoryWriteResult {
    const now = input.validFromMs ?? Date.now();
    const memoryId = input.memoryId ?? crypto.randomUUID();
    const versionId = input.versionId ?? crypto.randomUUID();
    const principal = this.get('SELECT * FROM principals WHERE principal_id = ?', [input.principalId]) as any | undefined;
    if (!principal) {
      return { ok: false, error: `Unknown principal ${input.principalId}` };
    }
    if (principal.status === 'revoked') {
      return { ok: false, error: `Principal ${input.principalId} is revoked` };
    }
    if (principal.status === 'expired') {
      return { ok: false, error: `Principal ${input.principalId} is expired` };
    }
    if (principal.expires_at != null && Number(principal.expires_at) <= now) {
      this.run('UPDATE principals SET status = ? WHERE principal_id = ?', ['expired', input.principalId]);
      return { ok: false, error: `Principal ${input.principalId} is expired` };
    }

    this.run(
      'INSERT OR IGNORE INTO memory_records (memory_id, namespace, subject_key, memory_type, created_by, created_at, status) VALUES (?,?,?,?,?,?,?)',
      [memoryId, input.namespace, input.subjectKey, input.memoryType ?? 'fact', input.principalId, now, 'active'],
    );
    this.run(
      'UPDATE memory_records SET namespace = ?, subject_key = ?, memory_type = ?, created_by = ?, created_at = ?, status = ? WHERE memory_id = ?',
      [input.namespace, input.subjectKey, input.memoryType ?? 'fact', input.principalId, now, 'active', memoryId],
    );

    const superseded = this.get(
      'SELECT version_id FROM memory_versions WHERE memory_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      [memoryId, 'active'],
    ) as { version_id: string } | undefined;
    if (superseded?.version_id) {
      this.run('UPDATE memory_versions SET status = ? WHERE version_id = ?', ['superseded', superseded.version_id]);
    }

    this.run(
      'INSERT INTO memory_versions (version_id, memory_id, payload_json, confidence, evidence_ref_count, valid_from, valid_to, supersedes_version_id, created_at, status) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        versionId,
        memoryId,
        JSON.stringify(input.payload ?? {}),
        typeof input.confidence === 'number' ? input.confidence : 0.5,
        Array.isArray(input.evidence) ? input.evidence.length : 0,
        now,
        typeof input.validToMs === 'number' ? input.validToMs : null,
        superseded?.version_id ?? null,
        now,
        'active',
      ],
    );

    for (const evidence of input.evidence ?? []) {
      const evidenceId = crypto.randomUUID();
      this.run(
        'INSERT INTO memory_evidence (evidence_id, version_id, source_type, source_ref, excerpt_hash, captured_at) VALUES (?,?,?,?,?,?)',
        [evidenceId, versionId, evidence.sourceType, evidence.sourceRef, evidence.excerptHash ?? null, evidence.capturedAtMs ?? now],
      );
    }

    const competing = this.all(
      `SELECT mv.version_id, mv.payload_json
       FROM memory_versions mv
       JOIN memory_records mr ON mr.memory_id = mv.memory_id
       WHERE mr.namespace = ? AND mr.subject_key = ? AND mr.memory_type = ?
         AND mv.status = ? AND mv.version_id <> ?`,
      [input.namespace, input.subjectKey, input.memoryType ?? 'fact', 'active', versionId],
    );
    for (const candidate of competing) {
      if (String(candidate.payload_json) === JSON.stringify(input.payload ?? {})) continue;
      const existingConflict = this.get(
        `SELECT conflict_id FROM memory_conflicts
         WHERE conflict_type = ? AND ((left_version_id = ? AND right_version_id = ?) OR (left_version_id = ? AND right_version_id = ?))`,
        ['contradiction', versionId, candidate.version_id, candidate.version_id, versionId],
      );
      if (!existingConflict) {
        this.run(
          'INSERT INTO memory_conflicts (conflict_id, left_version_id, right_version_id, conflict_type, resolution_state, winner_version_id, created_at) VALUES (?,?,?,?,?,?,?)',
          [crypto.randomUUID(), versionId, candidate.version_id, 'contradiction', 'open', null, now],
        );
      }
    }

    this.run('INSERT INTO memory_access_log (access_id, principal_id, operation, request_fingerprint, created_at) VALUES (?,?,?,?,?)', [crypto.randomUUID(), input.principalId, 'create', memoryId, now]);

    return { ok: true, memoryId, versionId, status: 'active' };
  }

  queryMemory(input: MemoryQueryInput): MemoryQueryResult {
    const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    if (input.principalId) {
      const requester = this.get('SELECT * FROM principals WHERE principal_id = ?', [input.principalId]) as any | undefined;
      if (!requester || requester.status === 'revoked' || requester.status === 'expired') {
        return { results: [], total: 0 };
      }
      const metadata = JSON.parse(String(requester.metadata_json ?? '{}')) as Record<string, unknown>;
      const namespaces = metadata.namespaces;
      if (Array.isArray(namespaces) && !namespaces.includes(input.namespace)) {
        return { results: [], total: 0 };
      }
    }
    const rows = this.all(
      `SELECT mv.*, mr.namespace, mr.subject_key, mr.memory_type, mr.created_by, mr.status AS record_status
       FROM memory_versions mv
       JOIN memory_records mr ON mr.memory_id = mv.memory_id
       WHERE mr.namespace = ? AND mr.subject_key = ?${input.memoryType ? ' AND mr.memory_type = ?' : ''}
       ORDER BY mv.created_at DESC`,
      input.memoryType ? [input.namespace, input.subjectKey, input.memoryType] : [input.namespace, input.subjectKey],
    );

    const results: MemoryQueryEntry[] = [];
    for (const row of rows) {
      const principal = this.get('SELECT * FROM principals WHERE principal_id = ?', [row.created_by]) as any | undefined;
      const createdAt = Number(row.created_at ?? 0);
      const confidence = Number(row.confidence ?? 0);
      const evidenceCount = Number(row.evidence_ref_count ?? 0);
      const validTo = row.valid_to != null ? Number(row.valid_to) : undefined;
      const isExpired = (typeof validTo === 'number' && validTo <= nowMs) || String(row.status) === 'expired';
      const isSuperseded = String(row.status) === 'superseded';
      const isRevoked = principal?.status === 'revoked';
      if (isRevoked || (!input.includeExpired && isExpired) || (!input.includeSuperseded && isSuperseded) || (input.requireEvidence && evidenceCount === 0)) {
        continue;
      }
      const trustTier = String(principal?.trust_tier ?? 'neutral');
      const trustScore = trustTier === 'trusted' ? 1 : trustTier === 'neutral' ? 0.6 : 0.3;
      const recencyScore = Math.max(0.1, 1 - Math.min(1, (nowMs - createdAt) / (1000 * 60 * 60 * 24 * 7)));
      const evidenceScore = Math.min(1, evidenceCount / 2);
      const penalty = isExpired ? 0.45 : 0;
      const score = 0.35 * trustScore + 0.25 * recencyScore + 0.2 * confidence + 0.2 * evidenceScore - penalty;
      const evidenceRefs = this.all('SELECT source_type, source_ref, excerpt_hash FROM memory_evidence WHERE version_id = ? ORDER BY captured_at, evidence_id', [row.version_id])
        .map((e: any) => ({
          sourceType: String(e.source_type),
          sourceRef: String(e.source_ref),
          ...(e.excerpt_hash ? { excerptHash: String(e.excerpt_hash) } : {}),
        }));
      const policyWarnings = [] as string[];
      if (isExpired) policyWarnings.push('expired');
      if (evidenceCount === 0) policyWarnings.push('low evidence');
      if (isSuperseded) policyWarnings.push('superseded');
      const acceptedRules = ['principal active', 'validity accepted'];
      if (evidenceCount > 0) acceptedRules.push('evidence present');

      results.push({
        memoryId: String(row.memory_id),
        versionId: String(row.version_id),
        namespace: String(row.namespace),
        subjectKey: String(row.subject_key),
        memoryType: String(row.memory_type) as MemoryType,
        payload: JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>,
        confidence,
        status: String(row.status) as MemoryStatus,
        score,
        scoreComponents: { trust: trustScore, recency: recencyScore, confidence, evidence: evidenceScore, penalty },
        evidenceCount,
        createdAt,
        policyWarnings,
        acceptedRules,
        evidenceRefs,
      });
    }

    results.sort((a, b) => b.score - a.score || b.scoreComponents.trust - a.scoreComponents.trust || b.createdAt - a.createdAt || a.versionId.localeCompare(b.versionId));
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : results.length;
    return { results: results.slice(0, limit), total: results.length };
  }

  resolveConflict(input: { leftVersionId: string; rightVersionId: string; conflictType?: string; winnerVersionId?: string }): MemoryConflictResult {
    const resolutionState = input.winnerVersionId ? 'winner_selected' : 'open';
    const existing = this.get(
      `SELECT conflict_id FROM memory_conflicts
       WHERE ((left_version_id = ? AND right_version_id = ?) OR (left_version_id = ? AND right_version_id = ?))
         AND resolution_state = ? ORDER BY created_at DESC LIMIT 1`,
      [input.leftVersionId, input.rightVersionId, input.rightVersionId, input.leftVersionId, 'open'],
    ) as { conflict_id: string } | undefined;
    if (existing && input.winnerVersionId) {
      this.run(
        'UPDATE memory_conflicts SET resolution_state = ?, winner_version_id = ? WHERE conflict_id = ?',
        ['winner_selected', input.winnerVersionId, existing.conflict_id],
      );
      return { conflictId: existing.conflict_id, resolutionState: 'winner_selected' };
    }
    const conflictId = crypto.randomUUID();
    this.run(
      'INSERT INTO memory_conflicts (conflict_id, left_version_id, right_version_id, conflict_type, resolution_state, winner_version_id, created_at) VALUES (?,?,?,?,?,?,?)',
      [conflictId, input.leftVersionId, input.rightVersionId, input.conflictType ?? 'contradiction', resolutionState, input.winnerVersionId ?? null, Date.now()],
    );
    return { conflictId, resolutionState };
  }

  listConflicts(input: { versionId?: string; includeResolved?: boolean } = {}): MemoryConflict[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.versionId) {
      conditions.push('(left_version_id = ? OR right_version_id = ?)');
      params.push(input.versionId, input.versionId);
    }
    if (!input.includeResolved) {
      conditions.push('resolution_state = ?');
      params.push('open');
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.all(`SELECT * FROM memory_conflicts ${where} ORDER BY created_at, conflict_id`, params as any[]).map((row: any) => ({
      conflictId: String(row.conflict_id),
      leftVersionId: String(row.left_version_id),
      rightVersionId: String(row.right_version_id),
      conflictType: String(row.conflict_type),
      resolutionState: String(row.resolution_state) as MemoryConflict['resolutionState'],
      ...(row.winner_version_id ? { winnerVersionId: String(row.winner_version_id) } : {}),
      createdAt: Number(row.created_at),
    }));
  }

  backfillLegacyA2AMemory(): MemoryBackfillResult {
    const legacyNodes = this.all(
      `SELECT n.*, f.path AS file_path FROM nodes n
       JOIN files f ON f.id = n.file_id
       WHERE f.path LIKE 'a2a/%' AND n.doc IS NOT NULL
       ORDER BY n.id`,
    );
    let importedCount = 0;
    let skippedCount = 0;
    for (const node of legacyNodes) {
      const marker = `legacy-a2a:${node.id}`;
      if (this.getMeta(marker)) {
        skippedCount++;
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(node.doc)) as Record<string, unknown>;
      } catch {
        payload = { doc: String(node.doc) };
      }
      const principalId = typeof payload.agent_id === 'string' ? payload.agent_id : 'legacy-import';
      if (!this.get('SELECT principal_id FROM principals WHERE principal_id = ?', [principalId])) {
        this.registerPrincipal({ principalId, trustTier: 'legacy', metadata: { imported: true } });
      }
      const result = this.writeMemory({
        principalId,
        namespace: 'legacy-a2a',
        subjectKey: String(node.qualified_name),
        memoryType: 'observation',
        payload,
        confidence: 0.4,
        evidence: [{ sourceType: 'legacy_import', sourceRef: String(node.file_path), excerptHash: crypto.createHash('sha256').update(String(node.doc)).digest('hex') }],
      });
      if (result.ok) {
        this.setMeta(marker, result.versionId ?? 'imported');
        importedCount++;
      } else {
        skippedCount++;
      }
    }
    return { importedCount, skippedCount };
  }

  expireMemory(input: { nowMs?: number }): MemoryExpiryResult {
    const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    const rows = this.all('SELECT version_id, memory_id FROM memory_versions WHERE status <> ? AND valid_to IS NOT NULL AND valid_to <= ?', ['expired', nowMs]);
    for (const row of rows) {
      this.run('UPDATE memory_versions SET status = ? WHERE version_id = ?', ['expired', row.version_id]);
      const activeCount = Number(this.get('SELECT COUNT(*) as c FROM memory_versions WHERE memory_id = ? AND status = ?', [row.memory_id, 'active'])?.c ?? 0);
      if (activeCount === 0) {
        this.run('UPDATE memory_records SET status = ? WHERE memory_id = ?', ['expired', row.memory_id]);
      }
    }
    return { expiredCount: rows.length };
  }

  compactMemory(input: { nowMs?: number; retentionMs?: number }): MemoryCompactionResult {
    const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    const retentionMs = typeof input.retentionMs === 'number' && input.retentionMs > 0 ? input.retentionMs : 7 * 24 * 60 * 60 * 1000;
    const rows = this.all(
      'SELECT memory_id FROM memory_records WHERE status IN (?, ?) AND created_at < ?',
      ['expired', 'revoked', nowMs - retentionMs],
    );
    for (const row of rows) {
      this.run('UPDATE memory_records SET status = ? WHERE memory_id = ?', ['tombstoned', row.memory_id]);
    }
    return { tombstonedCount: rows.length };
  }

  close(): void {
    this.save();
  }
}

// ── Fuzzy-search helpers ───────────────────────────────────────────

/** Generate the set of trigrams for a string. */
function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  const padded = `  ${s} `;
  for (let i = 0; i < padded.length - 2; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** Jaccard similarity between two trigram sets (0..1). */
function trigramSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
