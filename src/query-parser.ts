/**
 * Field-qualified query parser.
 *
 * Supports: kind:function lang:typescript path:src/ name:handle
 * Remaining tokens become free-text terms for keyword search.
 */
import type { ParsedQuery } from './types';

const FIELD_RE = /\b(kind|lang|language|path|file|name):(\S+)/gi;

export function parseQuery(raw: string): ParsedQuery {
  const result: ParsedQuery = { terms: [] };

  // Extract field qualifiers
  const cleaned = raw.replace(FIELD_RE, (_match, field: string, value: string) => {
    const f = field.toLowerCase();
    switch (f) {
      case 'kind':
        result.kind = value.toLowerCase();
        break;
      case 'lang':
      case 'language':
        result.lang = value.toLowerCase();
        break;
      case 'path':
      case 'file':
        result.file = value;
        break;
      case 'name':
        result.name = value;
        break;
    }
    return ''; // remove from free-text
  });

  // Remaining = free-text terms
  result.terms = cleaned
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0);

  // If name: was specified, prepend it to terms for keyword matching
  if (result.name && !result.terms.includes(result.name)) {
    result.terms.unshift(result.name);
  }

  return result;
}
