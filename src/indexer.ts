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
import fg from 'fast-glob';
import { GraphDB } from './storage';
import { parseFile } from './parser';
import { DEFAULT_CONFIG, detectLanguage, getDbPath } from './config';
import { extractRoutes } from './frameworks';
import { synthesizeEdges } from './synthesizer';
import { buildIgnoreFilter } from './gitignore';
import type { ParsedSymbol, ParsedCall, ParsedImport, GraphConfig, ParsedRoute } from './types';

export interface IndexResult {
  files_scanned: number;
  files_changed: number;
  files_removed: number;
  nodes_total: number;
  edges_total: number;
  duration_ms: number;
}

export async function indexProject(
  rootDir: string,
  opts: { force?: boolean; config?: Partial<GraphConfig> } = {},
): Promise<IndexResult> {
  const t0 = Date.now();
  const cfg = { ...DEFAULT_CONFIG, ...opts.config };
  const dbPath = getDbPath(rootDir);
  const db = await GraphDB.open(dbPath);

  try {
    // 1. Discover files (use .gitignore if available)
    const ignoreFilter = buildIgnoreFilter(rootDir);
    const patterns = cfg.extensions.map(ext => `**/*${ext}`);
    const ignore = cfg.ignorePaths.map(p => `**/${p}/**`);
    const filePaths = (await fg(patterns, {
      cwd: rootDir,
      ignore,
      absolute: false,
      dot: false,
    })).filter(fp => !ignoreFilter.ignores(fp));

    const knownPaths = new Set(filePaths.map(normSlash));

    // 2. Remove stale files
    const filesRemoved = db.transaction(() => db.removeStaleFiles(knownPaths));

    // 3. Parse changed files
    let filesChanged = 0;
    const allParseData: Map<number, {
      calls: ParsedCall[];
      imports: ParsedImport[];
      symbols: ParsedSymbol[];
      relPath: string;
    }> = new Map();

    db.transaction(() => {
      for (const rel of filePaths) {
        const relNorm = normSlash(rel);
        const abs = path.resolve(rootDir, rel);
        const stat = fs.statSync(abs);
        const language = detectLanguage(rel);
        if (!language) continue;

        // Tier-1: mtime+size fast check (skip hash if unchanged)
        if (!opts.force) {
          const existing = db.getFile(relNorm);
          if (existing &&
              existing.mtime === stat.mtimeMs &&
              existing.size === stat.size) {
            // unchanged — still collect raw_refs for edge resolution
            continue;
          }
        }

        // Tier-2: read + hash
        const content = fs.readFileSync(abs, 'utf-8');
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const { id: fileId, changed } = db.upsertFile(
          relNorm, hash, language, stat.size, stat.mtimeMs,
          opts.force,
        );

        if (!changed && !opts.force) continue;
        filesChanged++;

        // Parse
        const result = parseFile(content, language, relNorm);

        // Extract framework routes
        const routes = extractRoutes(content, relNorm, language);
        for (const route of routes) {
          db.insertNode(
            fileId, `${route.method} ${route.pattern}`,
            `${relNorm}::route:${route.pattern}`, 'route',
            route.line, route.line,
            `${route.method} ${route.pattern}`, null, true,
          );
          // Store a raw ref to link route → handler
          db.insertRawRef(fileId, 'call', `${relNorm}::route:${route.pattern}`,
            route.handler, null, null, route.line);
        }

        // Synthesize dynamic dispatch edges
        const synthEdges = synthesizeEdges(result.calls, relNorm);
        for (const se of synthEdges) {
          db.insertRawRef(fileId, 'call', se.sourceQName,
            se.targetName, null, null, se.line);
        }

        // Store symbols
        storeSymbols(db, fileId, result.symbols);

        // Store raw_refs (calls + imports + extends)
        storeRawRefs(db, fileId, relNorm, result);

        allParseData.set(fileId, {
          calls: result.calls,
          imports: result.imports,
          symbols: result.symbols,
          relPath: relNorm,
        });
      }
    });

    // 4. Resolve edges (full rebuild from raw_refs)
    db.transaction(() => {
      db.clearAllEdges();
      resolveEdges(db, rootDir);
    });

    // 5. Classify roles
    db.transaction(() => classifyRoles(db));

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
  if (!moduleSpec.startsWith('.')) return null; // external package
  const dir = path.dirname(importerPath);
  let resolved = path.posix.join(dir, moduleSpec);
  // Normalize
  resolved = normSlash(resolved);
  // Try common extensions
  return resolved;
}

// ─── role classification ────────────────────────────────────────
function classifyRoles(db: GraphDB): void {
  const nodes = db.getAllNodes();
  for (const node of nodes) {
    const incoming = db.getEdgesTo(node.id, 'calls');
    const outgoing = db.getEdgesFrom(node.id, 'calls');
    const isExported = node.exported === 1;

    let role: string;
    if (incoming.length === 0 && !isExported && outgoing.length === 0) {
      role = 'dead';
    } else if (incoming.length === 0 && isExported) {
      role = 'entry';
    } else if (incoming.length >= 3) {
      role = 'core';
    } else if (outgoing.length > 0 && incoming.length === 0) {
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
