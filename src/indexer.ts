/**
 * Indexer — walks a project directory, parses source files, stores symbols
 * and raw references, then resolves cross-file edges.
 *
 * Incremental: 3-tier change detection (mtime+size → hash → skip).
 * Edge resolution: import-aware > same-file > global name match.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import os from 'os';
import fg from 'fast-glob';
import { GraphDB } from './storage';
import { parseFile } from './parser';
import { DEFAULT_CONFIG, detectLanguage, getDbPath, loadConfig } from './config';
import { extractRoutes } from './frameworks';
import { synthesizeEdges } from './synthesizer';
import { buildIgnoreFilter } from './gitignore';
import { coerceFingerprintLevel, type FingerprintLevel } from './fingerprint';
import { initTreeSitter } from './treesitter';
import type { ParsedSymbol, ParsedCall, ParsedImport, GraphConfig, ParsedRoute } from './types';

export interface IndexResult {
  files_scanned: number;
  files_changed: number;
  files_removed: number;
  nodes_total: number;
  edges_total: number;
  duration_ms: number;
}

// ─── indexProject pipeline helpers ─────────────────────────────

interface PendingFile {
  fileId: number;
  content: string;
  language: string;
  relNorm: string;
}

/** Phase 1: discover source files respecting .gitignore and config ignore paths */
async function discoverFiles(rootDir: string, cfg: GraphConfig): Promise<string[]> {
  const ignoreFilter = buildIgnoreFilter(rootDir);
  const patterns = cfg.extensions.map(ext => `**/*${ext}`);
  const ignore = cfg.ignorePaths.map(p => `**/${p}/**`);
  return (await fg(patterns, { cwd: rootDir, ignore, absolute: false, dot: false }))
    .filter(fp => !ignoreFilter.ignores(fp));
}

/** Phase 2: determine which files need re-parsing using 3-tier change detection */
function collectPendingFiles(
  db: GraphDB, rootDir: string, filePaths: string[],
  opts: { force?: boolean },
): { pending: PendingFile[]; filesChanged: number } {
  let filesChanged = 0;
  const pending: PendingFile[] = [];

  db.transaction(() => {
    for (const rel of filePaths) {
      const relNorm = normSlash(rel);
      const abs = path.resolve(rootDir, rel);
      const stat = fs.statSync(abs);
      const language = detectLanguage(rel);
      if (!language) continue;

      if (!opts.force) {
        const existing = db.getFile(relNorm);
        if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) continue;
      }

      const content = fs.readFileSync(abs, 'utf-8');
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const { id: fileId, changed } = db.upsertFile(relNorm, hash, language, stat.size, stat.mtimeMs, opts.force);

      if (!changed && !opts.force) continue;
      filesChanged++;
      pending.push({ fileId, content, language, relNorm });
    }
  });

  return { pending, filesChanged };
}

/** Phase 3: parse files — parallel for large batches, serial for small ones */
async function executeParsePhase(
  pending: PendingFile[],
  fingerprintLevel: FingerprintLevel,
): Promise<Map<number, { fileId: number; relNorm: string; content: string; result: ReturnType<typeof parseFile> }>> {
  const WORKER_THRESHOLD = 8;
  const parseResults: Map<number, { fileId: number; relNorm: string; content: string; result: ReturnType<typeof parseFile> }> = new Map();

  // Loading the WASM grammars is async but parsing is not, so the runtime has
  // to be ready before any parseFile call. Workers initialize independently.
  if (fingerprintLevel >= 3) await initTreeSitter();

  if (pending.length >= WORKER_THRESHOLD) {
    const results = await parseFilesParallel(pending, fingerprintLevel);
    for (const r of results) parseResults.set(r.fileId, r);
  } else {
    for (const p of pending) {
      const result = parseFile(p.content, p.language, p.relNorm, { fingerprintLevel });
      parseResults.set(p.fileId, { fileId: p.fileId, relNorm: p.relNorm, content: p.content, result });
    }
  }
  return parseResults;
}

/** Phase 4: store symbols, routes, edges into the DB */
function storeParsePhase(
  db: GraphDB,
  parseResults: Map<number, { fileId: number; relNorm: string; content: string; result: ReturnType<typeof parseFile> }>,
  allParseData: Map<number, { calls: ParsedCall[]; imports: ParsedImport[]; symbols: ParsedSymbol[]; relPath: string }>,
): void {
  db.transaction(() => {
    for (const [fileId, { relNorm, content, result }] of parseResults) {
      const language = detectLanguage(relNorm) ?? '';
      for (const route of extractRoutes(content, relNorm, language)) {
        db.insertNode(fileId, `${route.method} ${route.pattern}`,
          `${relNorm}::route:${route.pattern}`, 'route',
          route.line, route.line, `${route.method} ${route.pattern}`, null, true);
        db.insertRawRef(fileId, 'call', `${relNorm}::route:${route.pattern}`,
          route.handler, null, null, route.line);
      }
      for (const se of synthesizeEdges(result.calls, relNorm)) {
        db.insertRawRef(fileId, 'call', se.sourceQName, se.targetName, null, null, se.line);
      }
      storeSymbols(db, fileId, result.symbols);
      storeRawRefs(db, fileId, relNorm, result);
      allParseData.set(fileId, { calls: result.calls, imports: result.imports, symbols: result.symbols, relPath: relNorm });
    }
  });
}

/** Phase 5: resolve cross-file edges and classify symbol roles */
function resolveAndClassify(
  db: GraphDB, rootDir: string,
  changedFileIds: number[], filePaths: string[],
  opts: { force?: boolean },
): void {
  const incrementalThreshold = Math.max(10, Math.floor(filePaths.length * 0.2));
  db.transaction(() => {
    if (changedFileIds.length > 0 && changedFileIds.length <= incrementalThreshold && !opts.force) {
      db.clearEdgesForFiles(changedFileIds);
    } else {
      db.clearAllEdges();
    }
    resolveEdges(db, rootDir);
  });
  db.transaction(() => classifyRoles(db));
}

export async function indexProject(
  rootDir: string,
  opts: { force?: boolean; config?: Partial<GraphConfig> } = {},
): Promise<IndexResult> {
  const t0 = Date.now();
  const cfg = { ...loadConfig(rootDir), ...opts.config };
  const db = await GraphDB.open(getDbPath(rootDir));

  try {
    const filePaths  = await discoverFiles(rootDir, cfg);
    const knownPaths = new Set(filePaths.map(normSlash));

    const filesRemoved = db.transaction(() => db.removeStaleFiles(knownPaths));
    const { pending, filesChanged } = collectPendingFiles(db, rootDir, filePaths, opts);

    const allParseData: Map<number, { calls: ParsedCall[]; imports: ParsedImport[]; symbols: ParsedSymbol[]; relPath: string }> = new Map();
    const fingerprintLevel = coerceFingerprintLevel(cfg.memory?.fingerprintLevel);
    const parseResults = await executeParsePhase(pending, fingerprintLevel);
    storeParsePhase(db, parseResults, allParseData);
    resolveAndClassify(db, rootDir, [...parseResults.keys()], filePaths, opts);

    db.setMeta('last_index', new Date().toISOString());
    const status = db.getStatus(rootDir);
    return {
      files_scanned: filePaths.length,
      files_changed: filesChanged,
      files_removed: filesRemoved,
      nodes_total: status.nodes_count,
      edges_total: status.edges_count,
      duration_ms: Date.now() - t0,
    };
  } finally {
    db.close();
  }
}


// ─── store symbols recursively ──────────────────────────────────
function storeSymbols(db: GraphDB, fileId: number, symbols: ParsedSymbol[]): void {
  for (const sym of symbols) {
    db.insertNode(
      fileId, sym.name, sym.qualifiedName, sym.kind,
      sym.startLine, sym.endLine,
      sym.signature, sym.doc, sym.exported,
      sym.fingerprint ?? null, sym.fingerprintLevel ?? null,
    );
    if (sym.children.length > 0) storeSymbols(db, fileId, sym.children);
  }
}

// ─── store raw references ───────────────────────────────────────
function storeRawRefs(
  db: GraphDB, fileId: number, relPath: string,
  result: { calls: ParsedCall[]; imports: ParsedImport[]; symbols: ParsedSymbol[] },
): void {
  for (const call of result.calls) {
    db.insertRawRef(
      fileId, 'call',
      call.enclosingSymbol, call.callee,
      null, call.receiver ?? null, call.line,
    );
  }

  for (const imp of result.imports) {
    for (const spec of imp.specifiers) {
      db.insertRawRef(
        fileId, 'import',
        null, spec.name,
        imp.source, null, imp.line,
      );
    }
  }

  // extends / implements from symbols
  for (const sym of flattenSymbols(result.symbols)) {
    if (sym.extends) {
      db.insertRawRef(
        fileId, 'extends',
        sym.qualifiedName, sym.extends,
        null, null, sym.startLine,
      );
    }
    if (sym.implements) {
      for (const iface of sym.implements) {
        db.insertRawRef(
          fileId, 'implements',
          sym.qualifiedName, iface,
          null, null, sym.startLine,
        );
      }
    }
  }
}

function flattenSymbols(syms: ParsedSymbol[]): ParsedSymbol[] {
  const out: ParsedSymbol[] = [];
  for (const s of syms) {
    out.push(s);
    if (s.children.length > 0) out.push(...flattenSymbols(s.children));
  }
  return out;
}

// ─── edge resolution ────────────────────────────────────────────
//
// Priority (inspired by optave/codegraph):
//  1. Import-aware: if callee was imported, resolve to source file's export
//  2. Same-file: definition in the same file
//  3. Global name match: any symbol with that name
//
function resolveEdges(db: GraphDB, rootDir: string): void {
  const allRefs = db.getAllRawRefs();
  const allNodes = db.getAllNodes();
  const allFiles = db.getAllFiles();

  // Build lookup maps
  const nodesByName = new Map<string, typeof allNodes>();
  const nodeByQName = new Map<string, (typeof allNodes)[0]>();
  const nodesByFileId = new Map<number, typeof allNodes>();
  const filePathMap = new Map<number, string>();

  for (const f of allFiles) filePathMap.set(f.id, f.path);

  for (const n of allNodes) {
    nodeByQName.set(n.qualified_name, n);
    const arr = nodesByName.get(n.name) ?? [];
    arr.push(n);
    nodesByName.set(n.name, arr);

    const fileNodes = nodesByFileId.get(n.file_id) ?? [];
    fileNodes.push(n);
    nodesByFileId.set(n.file_id, fileNodes);
  }

  // Build per-file import map: file_id → { localName → resolved source path }
  const importMap = new Map<number, Map<string, string>>();
  for (const ref of allRefs) {
    if (ref.kind !== 'import' || !ref.target_module) continue;
    let map = importMap.get(ref.file_id);
    if (!map) { map = new Map(); importMap.set(ref.file_id, map); }
    const resolved = resolveModulePath(
      filePathMap.get(ref.file_id) ?? '', ref.target_module,
    );
    if (resolved) map.set(ref.target_name, resolved);
  }

  for (const ref of allRefs) {
    if (ref.kind === 'import') continue; // import edges handled below

    // Find source node (the caller / the class that extends)
    let sourceNode: (typeof allNodes)[0] | undefined;
    if (ref.source_qname) {
      sourceNode = nodeByQName.get(ref.source_qname);
    }
    if (!sourceNode) continue;

    // Find target node
    const targetNode = resolveTarget(
      ref.target_name, ref.receiver ?? null,
      ref.file_id, importMap, nodesByName, nodesByFileId, filePathMap,
    );
    if (!targetNode || targetNode.id === sourceNode.id) continue;

    db.insertEdge(sourceNode.id, targetNode.id, ref.kind === 'call' ? 'calls' : ref.kind);
  }

  // Import edges: file module → file module (for file-level dependency)
  // We create "imports" edges between any nodes in the importing file
  // and the imported file to represent the dependency.
  for (const ref of allRefs) {
    if (ref.kind !== 'import' || !ref.target_module) continue;
    const resolved = resolveModulePath(
      filePathMap.get(ref.file_id) ?? '', ref.target_module,
    );
    if (!resolved) continue;

    // Find target file's nodes matching the imported name
    const targetFile = allFiles.find(f => f.path === resolved ||
      f.path.startsWith(resolved));
    if (!targetFile) continue;

    const targetNodes = nodesByFileId.get(targetFile.id) ?? [];
    const matching = targetNodes.filter(n => n.name === ref.target_name && n.exported);
    if (matching.length > 0) {
      // Create import edge from any same-file node that references this
      const sourceFileNodes = nodesByFileId.get(ref.file_id) ?? [];
      if (sourceFileNodes.length > 0 && matching.length > 0) {
        // Create a single imports edge between first source-file node and target
        db.insertEdge(sourceFileNodes[0].id, matching[0].id, 'imports');
      }
    }
  }
}

function resolveTarget(
  name: string,
  receiver: string | null,
  fileId: number,
  importMap: Map<number, Map<string, string>>,
  nodesByName: Map<string, any[]>,
  nodesByFileId: Map<number, any[]>,
  filePathMap: Map<number, string>,
): any | undefined {
  const qualifiedName = receiver ? `${name}` : name; // method name

  // 1. Import-aware: check if this name was imported
  const fileImports = importMap.get(fileId);
  if (fileImports) {
    const sourceFile = fileImports.get(name) ?? fileImports.get(receiver ?? '');
    if (sourceFile) {
      const candidates = nodesByName.get(name) ?? [];
      const fromSource = candidates.find(n => {
        const filePath = filePathMap.get(n.file_id) ?? '';
        return filePath === sourceFile || filePath.startsWith(sourceFile);
      });
      if (fromSource) return fromSource;
    }
  }

  // 2. Same-file
  const sameFile = (nodesByFileId.get(fileId) ?? [])
    .find(n => n.name === name);
  if (sameFile) return sameFile;

  // 3. Global name match (first exported match wins)
  const globals = nodesByName.get(name) ?? [];
  const exported = globals.find(n => n.exported && n.file_id !== fileId);
  if (exported) return exported;

  return globals.find(n => n.file_id !== fileId);
}

function resolveModulePath(
  importerPath: string, moduleSpec: string,
): string | null {
  // C/C++ #include: "header.h" is project-relative, <system.h> was already stripped
  // Shell source/.: resolve relative paths
  // JS/TS: only relative imports (starting with .)
  
  // Skip system/external includes (no path separator, no relative prefix)
  if (!moduleSpec.startsWith('.') && !moduleSpec.includes('/')) {
    // Could be a C/C++ header in the same directory — try as-is
    const dir = path.dirname(importerPath);
    const candidate = normSlash(path.posix.join(dir, moduleSpec));
    // Return it; edge resolver will check if the file exists in the index
    if (moduleSpec.endsWith('.h') || moduleSpec.endsWith('.hpp') ||
        moduleSpec.endsWith('.hh') || moduleSpec.endsWith('.hxx') ||
        moduleSpec.endsWith('.sh') || moduleSpec.endsWith('.ps1') ||
        moduleSpec.endsWith('.psm1')) {
      return candidate;
    }
    return null; // external npm/pip package
  }

  const dir = path.dirname(importerPath);
  let resolved = path.posix.join(dir, moduleSpec);
  resolved = normSlash(resolved);
  return resolved;
}

// ─── role classification ────────────────────────────────────────
function classifyRoles(db: GraphDB): void {
  const nodes = db.getAllNodes();
  const testRe = /\.(test|spec|e2e)\.(ts|tsx|js|jsx|py)$|__tests?__\//i;

  // Pre-compute file paths for test detection
  const filePathCache = new Map<number, string>();
  const getFilePath = (fileId: number): string => {
    if (!filePathCache.has(fileId)) {
      const f = db.getFileById(fileId);
      filePathCache.set(fileId, f?.path ?? '');
    }
    return filePathCache.get(fileId)!;
  };

  // First pass: compute metrics for all nodes
  const metrics = new Map<number, { incoming: number; outgoing: number; isExported: boolean; isTest: boolean }>();
  for (const node of nodes) {
    const incoming = db.getEdgesTo(node.id, 'calls').length;
    const outgoing = db.getEdgesFrom(node.id, 'calls').length;
    const fp = getFilePath(node.file_id);
    metrics.set(node.id, {
      incoming,
      outgoing,
      isExported: node.exported === 1,
      isTest: testRe.test(fp),
    });
  }

  // Second pass: detect bridges (nodes whose removal disconnects subgraphs)
  // Approximate: a node is a bridge if it connects two groups that don't connect otherwise
  const bridgeCandidates = new Set<number>();
  for (const node of nodes) {
    const m = metrics.get(node.id)!;
    if (m.incoming >= 2 && m.outgoing >= 2) {
      // Check if callers and callees share no other connections
      const callerIds = db.getEdgesTo(node.id, 'calls').map(e => e.source_id);
      const calleeIds = db.getEdgesFrom(node.id, 'calls').map(e => e.target_id);
      const callerSet = new Set(callerIds);
      // If callees have no direct edges to/from any caller, this is a bridge
      let directConnections = 0;
      for (const cid of calleeIds) {
        const calleeCallers = db.getEdgesTo(cid, 'calls');
        for (const e of calleeCallers) {
          if (callerSet.has(e.source_id)) directConnections++;
        }
      }
      if (directConnections === 0) bridgeCandidates.add(node.id);
    }
  }

  // Classify
  for (const node of nodes) {
    const m = metrics.get(node.id)!;
    let role: string;

    if (m.isTest) {
      role = 'test';
    } else if (m.incoming === 0 && !m.isExported && m.outgoing === 0) {
      role = 'dead';
    } else if (m.incoming === 0 && m.isExported) {
      role = 'entry';
    } else if (m.incoming >= 3 && m.outgoing >= 3) {
      role = 'hub';       // high fan-in AND fan-out
    } else if (bridgeCandidates.has(node.id)) {
      role = 'bridge';    // connects otherwise-separate clusters
    } else if (m.incoming >= 3) {
      role = 'core';
    } else if (m.outgoing > 0 && m.incoming === 0) {
      role = 'leaf';
    } else {
      role = 'utility';
    }
    db.updateRole(node.id, role);
  }
}

// ─── util ───────────────────────────────────────────────────────
function normSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

// ─── Parallel parsing with worker threads ──────────────────────
interface PendingFile {
  fileId: number;
  content: string;
  language: string;
  relNorm: string;
}

interface ParsedFileResult {
  fileId: number;
  relNorm: string;
  content: string;
  result: ReturnType<typeof parseFile>;
}

async function parseFilesParallel(
  files: PendingFile[],
  fingerprintLevel: FingerprintLevel,
): Promise<ParsedFileResult[]> {
  const cpuCount = Math.max(1, os.cpus().length - 1);
  const workerCount = Math.min(cpuCount, files.length, 4);

  // Resolve the worker script path (compiled JS, not TS)
  const workerPath = path.resolve(__dirname, 'parse-worker.js');

  // If worker file doesn't exist (e.g. dev mode), fall back to single-threaded
  if (!fs.existsSync(workerPath)) {
    return files.map(f => ({
      fileId: f.fileId,
      relNorm: f.relNorm,
      content: f.content,
      result: parseFile(f.content, f.language, f.relNorm, { fingerprintLevel }),
    }));
  }

  const results: ParsedFileResult[] = [];
  const queue = [...files];

  const spawnWorker = (): Promise<void> => new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    const processNext = () => {
      const item = queue.shift();
      if (!item) {
        worker.terminate();
        resolve();
        return;
      }
      worker.postMessage({
        id: item.fileId,
        content: item.content,
        language: item.language,
        relPath: item.relNorm,
        fingerprintLevel,
      });
    };

    worker.on('message', (msg: { id: number; result: any; error: string | null }) => {
      if (msg.error) {
        // On worker parse error, fallback to empty parse
        const file = files.find(f => f.fileId === msg.id);
        if (file) {
          results.push({
            fileId: msg.id,
            relNorm: file.relNorm,
            content: file.content,
            result: { symbols: [], calls: [], imports: [] },
          });
        }
      } else {
        const file = files.find(f => f.fileId === msg.id);
        if (file) {
          results.push({
            fileId: msg.id,
            relNorm: file.relNorm,
            content: file.content,
            result: msg.result,
          });
        }
      }
      processNext();
    });

    worker.on('error', (err) => {
      // Worker crashed — process remaining items single-threaded
      while (queue.length) {
        const item = queue.shift()!;
        results.push({
          fileId: item.fileId,
          relNorm: item.relNorm,
          content: item.content,
          result: parseFile(item.content, item.language, item.relNorm, { fingerprintLevel }),
        });
      }
      resolve();
    });

    processNext();
  });

  await Promise.all(Array.from({ length: workerCount }, () => spawnWorker()));
  return results;
}
