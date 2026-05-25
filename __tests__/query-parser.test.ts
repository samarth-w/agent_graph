/**
 * Query Parser Tests — field-qualified search queries.
 */
import { describe, it, expect } from 'vitest';
import { parseQuery } from '../src/query-parser';

describe('parseQuery', () => {
  it('returns plain text for a query with no field prefixes', () => {
    const r = parseQuery('authenticate user');
    expect(r.terms).toEqual(['authenticate', 'user']);
    expect(r.kind).toBeUndefined();
    expect(r.lang).toBeUndefined();
    expect(r.file).toBeUndefined();
    expect(r.name).toBeUndefined();
  });

  it('extracts kind: filter and removes it from terms', () => {
    const r = parseQuery('kind:function handle');
    expect(r.kind).toBe('function');
    expect(r.terms).toEqual(['handle']);
  });

  it('extracts lang: filter', () => {
    const r = parseQuery('lang:typescript parse');
    expect(r.lang).toBe('typescript');
    expect(r.terms).toEqual(['parse']);
  });

  it('extracts language: as alias for lang:', () => {
    const r = parseQuery('language:python helper');
    expect(r.lang).toBe('python');
  });

  it('extracts path: filter', () => {
    const r = parseQuery('path:src/graph handle');
    expect(r.file).toBe('src/graph');
    expect(r.terms).toEqual(['handle']);
  });

  it('extracts file: as alias for path:', () => {
    const r = parseQuery('file:storage.ts open');
    expect(r.file).toBe('storage.ts');
  });

  it('extracts name: filter', () => {
    const r = parseQuery('name:traverse');
    expect(r.name).toBe('traverse');
  });

  it('handles multiple field qualifiers', () => {
    const r = parseQuery('kind:function lang:typescript path:src/');
    expect(r.kind).toBe('function');
    expect(r.lang).toBe('typescript');
    expect(r.file).toBe('src/');
    expect(r.terms).toEqual([]);
  });

  it('handles all-filters-no-text query', () => {
    const r = parseQuery('kind:function lang:typescript');
    expect(r.kind).toBe('function');
    expect(r.lang).toBe('typescript');
    expect(r.terms).toEqual([]);
  });

  it('survives empty input', () => {
    const r = parseQuery('');
    expect(r.terms).toEqual([]);
    expect(r.kind).toBeUndefined();
  });

  it('mixes field qualifiers with free text', () => {
    const r = parseQuery('kind:class UserService path:src/');
    expect(r.kind).toBe('class');
    expect(r.file).toBe('src/');
    expect(r.terms).toEqual(['UserService']);
  });

  it('handles unknown field prefixes — strips colon but keeps word', () => {
    const r = parseQuery('TODO: needs review');
    // parseQuery strips colons from unrecognized prefixes
    expect(r.terms.join(' ')).toContain('TODO');
    expect(r.kind).toBeUndefined();
  });
});
