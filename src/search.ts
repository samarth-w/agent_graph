/**
 * Symbol search — keyword matching with field-qualified query support.
 *
 * Supports: kind:function lang:typescript path:src/ name:handle freetext
 */
import { GraphDB } from './storage';
import { parseQuery } from './query-parser';
import type { SearchResult, ParsedQuery, IntentSearchResult, IntentMatch } from './types';

export function searchSymbols(
  db: GraphDB,
  query: string,
  opts: { limit?: number; kind?: string; file?: string } = {},
): SearchResult[] {
  const parsed = parseQuery(query);

  // Merge explicit opts over parsed fields
  const effectiveKind = opts.kind ?? parsed.kind;
  const effectiveFile = opts.file ?? parsed.file;

  // If only field qualifiers and no terms, search with name or wildcard
  const searchTerms = parsed.terms.length > 0
    ? parsed.terms.join(' ')
    : parsed.name ?? '';

  const hasOnlyFilters = !searchTerms && (effectiveKind || effectiveFile || parsed.lang || parsed.role || parsed.exported !== undefined);

  let results: SearchResult[];
  if (hasOnlyFilters) {
    // No text search — fetch all nodes and rely on post-filters
    const allNodes = db.getAllNodes();
    results = allNodes.map(n => {
      const f = db.getFileById(n.file_id);
      return { node: n, file_path: f?.path ?? '', rank: 0 };
    });
  } else {
    results = searchTerms
      ? db.ftsSearch(searchTerms, (opts.limit ?? 20) * 2)  // over-fetch for filtering
      : db.ftsSearch('*', (opts.limit ?? 20) * 2);
  }

  // Post-filter by kind
  if (effectiveKind) {
    results = results.filter(r => r.node.kind === effectiveKind);
  }

  // Post-filter by file path
  if (effectiveFile) {
    results = results.filter(r =>
      r.file_path.includes(effectiveFile),
    );
  }

  // Post-filter by language
  if (parsed.lang) {
    results = results.filter(r => {
      const fp = r.file_path.toLowerCase();
      const lang = parsed.lang!;
      if (lang === 'typescript' || lang === 'ts') return fp.endsWith('.ts') || fp.endsWith('.tsx');
      if (lang === 'javascript' || lang === 'js') return fp.endsWith('.js') || fp.endsWith('.jsx') || fp.endsWith('.mjs');
      if (lang === 'python' || lang === 'py') return fp.endsWith('.py') || fp.endsWith('.pyi');
      if (lang === 'go') return fp.endsWith('.go');
      if (lang === 'rust' || lang === 'rs') return fp.endsWith('.rs');
      if (lang === 'java') return fp.endsWith('.java');
      return true;
    });
  }

  // Post-filter by role
  if (parsed.role) {
    results = results.filter(r => r.node.role === parsed.role);
  }

  // Post-filter by exported
  if (parsed.exported !== undefined) {
    const exp = parsed.exported ? 1 : 0;
    results = results.filter(r => r.node.exported === exp);
  }

  const limit = opts.limit ?? 20;

  // Fuzzy fallback: if exact search returns fewer than 3 results, supplement with fuzzy
  if (results.length < 3 && searchTerms && searchTerms !== '*') {
    const seen = new Set(results.map(r => r.node.id));
    const fuzzy = db.fuzzySearch(searchTerms, limit);
    for (const fr of fuzzy) {
      if (!seen.has(fr.node.id)) {
        // Apply same filters
        if (effectiveKind && fr.node.kind !== effectiveKind) continue;
        if (effectiveFile && !fr.file_path.includes(effectiveFile)) continue;
        if (parsed.lang) {
          const fp = fr.file_path.toLowerCase();
          const lang = parsed.lang;
          if ((lang === 'typescript' || lang === 'ts') && !fp.endsWith('.ts') && !fp.endsWith('.tsx')) continue;
          if ((lang === 'javascript' || lang === 'js') && !fp.endsWith('.js') && !fp.endsWith('.jsx') && !fp.endsWith('.mjs')) continue;
          if ((lang === 'python' || lang === 'py') && !fp.endsWith('.py') && !fp.endsWith('.pyi')) continue;
          if ((lang === 'c' || lang === 'cpp' || lang === 'c++') && !fp.endsWith('.c') && !fp.endsWith('.h') && !fp.endsWith('.cpp') && !fp.endsWith('.hpp') && !fp.endsWith('.cc') && !fp.endsWith('.cxx')) continue;
          if ((lang === 'shell' || lang === 'bash' || lang === 'sh') && !fp.endsWith('.sh') && !fp.endsWith('.bash') && !fp.endsWith('.zsh')) continue;
          if ((lang === 'powershell' || lang === 'ps1') && !fp.endsWith('.ps1') && !fp.endsWith('.psm1')) continue;
        }
        results.push(fr);
        seen.add(fr.node.id);
      }
    }
  }

  return results.slice(0, limit);
}

// ─── BM25 Intent Search ────────────────────────────────────────

/** Tokenize text: split on space, camelCase, snake_case, punctuation */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
    .replace(/[_\-./:\\(){}[\]<>,;'"=+]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

export function intentSearch(
  db: GraphDB,
  query: string,
  opts: { limit?: number; kind?: string } = {},
): IntentSearchResult {
  const limit = opts.limit ?? 20;
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return { results: [], total: 0, query_terms: [] };

  const allNodes = db.getAllNodes();
  const N = allNodes.length;
  if (N === 0) return { results: [], total: 0, query_terms: queryTerms };

  // Build document for each node
  const docs: { node: typeof allNodes[0]; tokens: string[]; filePath: string }[] = [];
  for (const node of allNodes) {
    if (opts.kind && node.kind !== opts.kind) continue;
    const f = db.getFileById(node.file_id);
    const fp = f?.path ?? '';

    // Build document from name + qualified_name + signature + doc + caller/callee names
    const parts = [node.name, node.qualified_name, node.signature ?? '', node.doc ?? ''];
    const callers = db.getEdgesTo(node.id, 'calls').slice(0, 5);
    for (const e of callers) {
      const n = db.getNode(e.source_id);
      if (n) parts.push(n.name);
    }
    const callees = db.getEdgesFrom(node.id, 'calls').slice(0, 5);
    for (const e of callees) {
      const n = db.getNode(e.target_id);
      if (n) parts.push(n.name);
    }

    docs.push({ node, tokens: tokenize(parts.join(' ')), filePath: fp });
  }

  // Compute document frequencies per term
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.tokens.includes(term)) count++;
    }
    df.set(term, count);
  }

  // Avg document length
  const avgDl = docs.reduce((s, d) => s + d.tokens.length, 0) / (docs.length || 1);
  const k1 = 1.2;
  const b = 0.75;

  // Score each document
  const scored: IntentMatch[] = [];
  for (const doc of docs) {
    let score = 0;
    const matched: string[] = [];

    for (const term of queryTerms) {
      const termDf = df.get(term) || 0;
      if (termDf === 0) continue;
      const tf = doc.tokens.filter(t => t === term).length;
      if (tf === 0) continue;

      matched.push(term);
      const idf = Math.log((docs.length - termDf + 0.5) / (termDf + 0.5) + 1);
      const dl = doc.tokens.length;
      const tfScore = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl));
      score += idf * tfScore;
    }

    if (score > 0) {
      scored.push({
        name: doc.node.name,
        qualified_name: doc.node.qualified_name,
        kind: doc.node.kind,
        file: doc.filePath,
        line: doc.node.start_line,
        signature: doc.node.signature,
        score: Math.round(score * 1000) / 1000,
        matched_terms: matched,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    results: scored.slice(0, limit),
    total: scored.length,
    query_terms: queryTerms,
  };
}
