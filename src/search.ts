/**
 * Symbol search — keyword matching with field-qualified query support.
 *
 * Supports: kind:function lang:typescript path:src/ name:handle freetext
 */
import { GraphDB } from './storage';
import { parseQuery } from './query-parser';
import type { SearchResult, ParsedQuery } from './types';

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

  let results = searchTerms
    ? db.ftsSearch(searchTerms, (opts.limit ?? 20) * 2)  // over-fetch for filtering
    : db.ftsSearch('*', (opts.limit ?? 20) * 2);

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

  return results.slice(0, opts.limit ?? 20);
}
