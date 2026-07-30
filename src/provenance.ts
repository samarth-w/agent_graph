/**
 * Symbol-level provenance engine.
 *
 * Binds persistent agent memory to the code it was derived from at *symbol*
 * granularity rather than file granularity. A memory record is only invalidated
 * when the specific symbol its evidence points at actually changes semantically,
 * or when a symbol it transitively depends on changes.
 *
 * Two properties make this materially stronger than file-level cache busting:
 *
 * 1. Formatting-insensitive fingerprints — whitespace-only or re-indentation
 *    changes do not invalidate memory, so routine formatter runs do not wipe
 *    an agent's accumulated knowledge.
 * 2. Reverse call-graph expansion — a memory about `handleRequest` goes stale
 *    when a function it calls changes, not just when its own body changes.
 */
import fs from 'fs';
import path from 'path';
import { GraphDB } from './storage';
import { MemoryService } from './memory';
import { loadConfig } from './config';
import {
  coerceFingerprintLevel, computeFingerprint, normalizeWhitespace,
  type FingerprintLevel,
} from './fingerprint';
import type {
  NodeRecord,
  ProvenanceDiff,
  ProvenanceImpactedSymbol,
  ProvenanceSyncResult,
  SymbolFingerprint,
} from './types';

/** Default number of reverse call-graph hops walked from a changed symbol. */
export const DEFAULT_IMPACT_DEPTH = 2;

/**
 * Bumped whenever a change to canonicalization can alter a fingerprint for
 * source that did not itself change. Baselines written by a different version
 * are not comparable to fingerprints produced now.
 */
export const FINGERPRINT_ALGORITHM_VERSION = 2;

/** Metadata key holding the algorithm+level pair that produced the baseline. */
export const BASELINE_VERSION_KEY = 'provenance_baseline_version';

function baselineTag(level: FingerprintLevel): string {
  return `${FINGERPRINT_ALGORITHM_VERSION}:${level}`;
}

/**
 * Normalize a symbol body so cosmetic edits do not register as semantic change.
 * Retained as the level-1 primitive; richer levels live in `./fingerprint`.
 */
export function normalizeSymbolBody(lines: string[]): string {
  return normalizeWhitespace(lines.join('\n'));
}

/**
 * Fallback fingerprint for a symbol whose row predates fingerprint persistence
 * (or was inserted by a path that does not parse, such as a synthesized route).
 */
export function computeSymbolFingerprint(
  node: NodeRecord,
  fileLines: string[],
  language = '',
  level: FingerprintLevel = 1,
): string {
  const start = Math.max(0, node.start_line - 1);
  const end = Math.min(fileLines.length, Math.max(node.end_line, node.start_line));
  return computeFingerprint({
    identity: `${node.qualified_name}\u0000${node.kind}`,
    body: fileLines.slice(start, end).join('\n'),
    language,
    level,
  }).fingerprint;
}

/**
 * Build the current fingerprint snapshot for every indexed symbol.
 *
 * Fingerprints are computed once during indexing and persisted on the node row,
 * so the common path here is a pure in-memory read with no file I/O. Only rows
 * missing a stored fingerprint fall back to reading their source file, which
 * keeps a sync proportional to the symbols that changed rather than to the
 * total size of the repository.
 */
export function collectSymbolFingerprints(
  db: GraphDB,
  rootDir: string,
  level: FingerprintLevel = 1,
): SymbolFingerprint[] {
  const files = db.getFileMap();
  const contentCache = new Map<number, string[]>();
  const fingerprints: SymbolFingerprint[] = [];
  const seen = new Set<string>();

  for (const node of db.getAllNodes()) {
    const file = files.get(node.file_id);
    if (!file) continue;

    // Qualified names are unique per symbol; guard against duplicate rows.
    if (seen.has(node.qualified_name)) continue;
    seen.add(node.qualified_name);

    let fingerprint = node.fingerprint ?? null;
    if (!fingerprint) {
      let lines = contentCache.get(node.file_id);
      if (!lines) {
        try {
          lines = fs.readFileSync(path.join(rootDir, file.path), 'utf-8').split(/\r?\n/);
        } catch {
          lines = [];
        }
        contentCache.set(node.file_id, lines);
      }
      fingerprint = computeSymbolFingerprint(node, lines, file.language ?? '', level);
    }

    fingerprints.push({
      qualifiedName: node.qualified_name,
      filePath: file.path,
      fingerprint,
    });
  }
  return fingerprints;
}

/** Compare a stored baseline against the current snapshot. */
export function diffSymbolFingerprints(
  previous: Map<string, SymbolFingerprint>,
  current: SymbolFingerprint[],
): ProvenanceDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const currentKeys = new Set<string>();

  for (const entry of current) {
    currentKeys.add(entry.qualifiedName);
    const prior = previous.get(entry.qualifiedName);
    if (!prior) {
      added.push(entry.qualifiedName);
    } else if (prior.fingerprint !== entry.fingerprint) {
      changed.push(entry.qualifiedName);
    }
  }

  const removed = [...previous.keys()].filter((key) => !currentKeys.has(key));
  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}

/**
 * Expand a seed set of changed symbols into everything that depends on them by
 * walking incoming call/reference edges.
 */
export function expandImpactedSymbols(
  db: GraphDB,
  seeds: Array<{ qualifiedName: string; changeType: 'changed' | 'removed' }>,
  maxDepth: number = DEFAULT_IMPACT_DEPTH,
): ProvenanceImpactedSymbol[] {
  const files = db.getFileMap();
  const nodes = db.getAllNodes();
  const byQName = new Map<string, NodeRecord>();
  const byId = new Map<number, NodeRecord>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (!byQName.has(node.qualified_name)) byQName.set(node.qualified_name, node);
  }

  const { incoming } = db.getAdjacencyMaps();
  const impacted = new Map<string, ProvenanceImpactedSymbol>();
  const filePathFor = (node: NodeRecord | undefined): string =>
    node ? files.get(node.file_id)?.path ?? '' : '';

  interface QueueEntry { qualifiedName: string; depth: number }
  const queue: QueueEntry[] = [];

  for (const seed of seeds) {
    const node = byQName.get(seed.qualifiedName);
    impacted.set(seed.qualifiedName, {
      qualifiedName: seed.qualifiedName,
      filePath: filePathFor(node),
      changeType: seed.changeType,
      depth: 0,
    });
    queue.push({ qualifiedName: seed.qualifiedName, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const node = byQName.get(current.qualifiedName);
    if (!node) continue;

    for (const edge of incoming.get(node.id) ?? []) {
      const caller = byId.get(edge.source_id);
      if (!caller) continue;
      if (impacted.has(caller.qualified_name)) continue;

      impacted.set(caller.qualified_name, {
        qualifiedName: caller.qualified_name,
        filePath: filePathFor(caller),
        changeType: 'dependent',
        depth: current.depth + 1,
      });
      queue.push({ qualifiedName: caller.qualified_name, depth: current.depth + 1 });
    }
  }

  return [...impacted.values()].sort(
    (a, b) => a.depth - b.depth || a.qualifiedName.localeCompare(b.qualifiedName),
  );
}

export interface ProvenanceSyncOptions {
  /** Reverse-dependency hops to walk from each changed symbol. */
  maxDepth?: number;
  /** Compute and report impact without mutating memory or the baseline. */
  dryRun?: boolean;
  /** Explanation stamped onto invalidated versions. */
  reason?: string;
  /** Deterministic clock for tests. */
  nowMs?: number;
  /** Reuse an existing service instance (avoids reopening the store). */
  service?: MemoryService;
  /** Override the configured fingerprint normalization level. */
  fingerprintLevel?: FingerprintLevel;
}

/**
 * Detect semantic symbol changes since the last baseline and invalidate every
 * memory record whose evidence is anchored to an impacted symbol or its file.
 */
export function syncProvenance(
  db: GraphDB,
  rootDir: string,
  opts: ProvenanceSyncOptions = {},
): ProvenanceSyncResult {
  const startedAt = Date.now();
  const nowMs = opts.nowMs ?? startedAt;
  const maxDepth = opts.maxDepth ?? DEFAULT_IMPACT_DEPTH;
  const service = opts.service ?? new MemoryService(db);
  const level = opts.fingerprintLevel
    ?? coerceFingerprintLevel(loadConfig(rootDir).memory?.fingerprintLevel);

  const current = collectSymbolFingerprints(db, rootDir, level);
  const previous = service.getSymbolFingerprints();

  // A baseline recorded under a different normalization level or an older
  // canonicalizer is not comparable to the fingerprints just computed: equal
  // hashes no longer imply unchanged code. Diffing anyway would report "no
  // change" for symbols that did change, which is the one failure mode this
  // system exists to prevent. Treat every symbol as changed instead — that
  // costs re-derivation but cannot leave an agent acting on a stale belief.
  //
  // A cold start (no baseline at all) is different and is *not* a reset: there
  // is nothing to compare against, so we simply record the baseline.
  const expectedTag = baselineTag(level);
  const storedTag = db.getMeta(BASELINE_VERSION_KEY);
  const baselineReset = previous.size > 0 && storedTag !== expectedTag;

  const diff = baselineReset
    ? { added: [], removed: [], changed: current.map((s) => s.qualifiedName), unchanged: [] }
    : diffSymbolFingerprints(previous, current);

  const seeds: Array<{ qualifiedName: string; changeType: 'changed' | 'removed' }> = [
    ...diff.changed.map((qualifiedName) => ({ qualifiedName, changeType: 'changed' as const })),
    ...diff.removed.map((qualifiedName) => ({ qualifiedName, changeType: 'removed' as const })),
  ];

  const impactedSymbols = seeds.length > 0 ? expandImpactedSymbols(db, seeds, maxDepth) : [];

  // Evidence may be anchored either at the symbol or at the containing file.
  const sourceRefs = new Set<string>();
  for (const symbol of impactedSymbols) {
    sourceRefs.add(symbol.qualifiedName);
    if (symbol.filePath) sourceRefs.add(symbol.filePath);
  }
  for (const qualifiedName of diff.removed) {
    const prior = previous.get(qualifiedName);
    if (prior?.filePath) sourceRefs.add(prior.filePath);
  }

  let invalidatedCount = 0;
  let invalidatedVersionIds: string[] = [];

  if (!opts.dryRun) {
    if (sourceRefs.size > 0) {
      const result = service.invalidateBySources(
        [...sourceRefs],
        opts.reason ?? 'symbol_provenance_changed',
        nowMs,
      );
      invalidatedCount = result.invalidatedCount;
      invalidatedVersionIds = result.versionIds;
    }
    service.replaceSymbolFingerprints(current, nowMs);
    db.setMeta(BASELINE_VERSION_KEY, expectedTag);
  }

  const durationMs = Date.now() - startedAt;
  service.recordTrace({
    operation: 'provenance_sync',
    durationMs,
    status: 'ok',
    attributes: {
      scanned: current.length,
      changed: diff.changed.length,
      impacted: impactedSymbols.length,
      invalidated: invalidatedCount,
      dryRun: opts.dryRun === true,
      baselineReset,
    },
  });

  return {
    scannedSymbols: current.length,
    changedSymbols: diff.changed,
    addedSymbols: diff.added,
    removedSymbols: diff.removed,
    impactedSymbols,
    invalidatedCount,
    invalidatedVersionIds,
    durationMs,
    dryRun: opts.dryRun === true,
    baselineReset,
    baselineVersion: expectedTag,
  };
}
