/**
 * SQLite graph storage via sql.js (pure JS / WASM - zero native deps).
 *
 * sql.js keeps the DB in memory and writes to disk on save().
 * The GraphDB.open() factory is async because sql.js needs to load WASM.
 */
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import type {
  FileRecord, NodeRecord, EdgeRecord, SearchResult, StatusInfo,
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
  kind      TEXT    NOT NULL
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

CREATE TABLE IF NOT EXISTS metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ccr_cache (
  id            TEXT PRIMARY KEY,
  original_data TEXT NOT NULL,
  timestamp     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ccr_timestamp ON ccr_cache(timestamp);
`;

// --- Singleton WASM loader ------------------------------------------
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
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
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const SQL = await loadSql();
    let db: SqlJsDatabase;
    if (fs.existsSync(dbPath)) {
      const buf = fs.readFileSync(dbPath);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    const instance = new GraphDB(db, dbPath);
    instance.exec(SCHEMA);
    return instance;
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
    fs.writeFileSync(this.dbPath, Buffer.from(data));
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

  // -- CCR cache -----------------------------------------------------
  saveCcrEntry(id: string, originalData: string): void {
    this.run(
      'INSERT OR REPLACE INTO ccr_cache (id, original_data, timestamp) VALUES (?, ?, ?)',
      [id, originalData, Date.now()],
    );
  }

  getCcrEntry(id: string): string | undefined {
    const row = this.get('SELECT original_data FROM ccr_cache WHERE id = ?', [id]) as
      | { original_data?: string }
      | undefined;
    return row?.original_data;
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
  insertEdge(sourceId: number, targetId: number, kind: string): void {
    const existing = this.get(
      'SELECT id FROM edges WHERE source_id=? AND target_id=? AND kind=?',
      [sourceId, targetId, kind],
    );
    if (!existing) {
      this.run(
        'INSERT INTO edges (source_id,target_id,kind) VALUES (?,?,?)',
        [sourceId, targetId, kind],
      );
    }
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

  close(): void {
    this.save();
    this.db.close();
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
