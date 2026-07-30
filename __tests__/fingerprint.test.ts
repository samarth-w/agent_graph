import { describe, it, expect } from 'vitest';
import { parse as babelParse } from '@babel/parser';
import {
  computeFingerprint,
  stripComments,
  normalizeWhitespace,
  coerceFingerprintLevel,
  canonicalizeAst,
  type FingerprintLevel,
} from '../src/fingerprint';

function jsAst(code: string): any {
  const ast = babelParse(code, { sourceType: 'module', plugins: ['typescript'] });
  return ast.program.body[0];
}

function fp(body: string, level: FingerprintLevel, opts: { language?: string; ast?: unknown } = {}) {
  return computeFingerprint({
    identity: 'mod::sym',
    body,
    language: opts.language ?? 'javascript',
    level,
    astNode: opts.ast,
  });
}

describe('fingerprint normalization levels', () => {
  const BASE = 'function f(a) {\n  const rate = 2;\n  return a * rate;\n}';

  it('L0 treats any byte difference as a change', () => {
    const reindented = 'function f(a) {\n    const rate = 2;\n    return a * rate;\n}';
    expect(fp(BASE, 0).fingerprint).not.toBe(fp(reindented, 0).fingerprint);
  });

  it('L1 ignores reindentation and blank lines but not comments', () => {
    const reindented = 'function f(a) {\n\n    const rate = 2;\n\n    return a * rate;\n}';
    expect(fp(BASE, 1).fingerprint).toBe(fp(reindented, 1).fingerprint);

    const commented = 'function f(a) {\n  // pick a rate\n  const rate = 2;\n  return a * rate;\n}';
    expect(fp(BASE, 1).fingerprint).not.toBe(fp(commented, 1).fingerprint);
  });

  it('L2 ignores comment edits', () => {
    const commented = 'function f(a) {\n  // pick a rate\n  const rate = 2;\n  return a * rate; // scale\n}';
    const recommented = 'function f(a) {\n  /* totally different note */\n  const rate = 2;\n  return a * rate;\n}';
    expect(fp(BASE, 2).fingerprint).toBe(fp(commented, 2).fingerprint);
    expect(fp(commented, 2).fingerprint).toBe(fp(recommented, 2).fingerprint);
  });

  it('L2 does not strip comment markers that appear inside strings', () => {
    const a = 'const url = "https://example.com/x";';
    const b = 'const url = "https://example.com/y";';
    expect(fp(a, 2).fingerprint).not.toBe(fp(b, 2).fingerprint);
    expect(stripComments(a, 'javascript')).toContain('https://example.com/x');
  });

  it('L3 ignores formatting differences that L1 cannot see', () => {
    const compact = 'function f(a){const rate=2;return a*rate;}';
    const spaced = 'function f( a ) {\n  const rate = 2 ;\n  return a * rate ;\n}';
    // Text-based levels disagree because token spacing differs.
    expect(fp(compact, 1).fingerprint).not.toBe(fp(spaced, 1).fingerprint);
    // Structural comparison sees them as identical.
    expect(fp(compact, 3, { ast: jsAst(compact) }).fingerprint)
      .toBe(fp(spaced, 3, { ast: jsAst(spaced) }).fingerprint);
  });

  it('L3 still distinguishes a changed literal', () => {
    const changed = 'function f(a) {\n  const rate = 3;\n  return a * rate;\n}';
    expect(fp(BASE, 3, { ast: jsAst(BASE) }).fingerprint)
      .not.toBe(fp(changed, 3, { ast: jsAst(changed) }).fingerprint);
  });

  it('L3 distinguishes a renamed local but L4 does not', () => {
    const renamed = 'function f(a) {\n  const factor = 2;\n  return a * factor;\n}';
    expect(fp(BASE, 3, { ast: jsAst(BASE) }).fingerprint)
      .not.toBe(fp(renamed, 3, { ast: jsAst(renamed) }).fingerprint);
    expect(fp(BASE, 4, { ast: jsAst(BASE) }).fingerprint)
      .toBe(fp(renamed, 4, { ast: jsAst(renamed) }).fingerprint);
  });

  it('L4 does not rename external references, so call-graph edges stay distinct', () => {
    const callsAlpha = 'function f(a) {\n  return alpha(a);\n}';
    const callsBeta = 'function f(a) {\n  return beta(a);\n}';
    expect(fp(callsAlpha, 4, { ast: jsAst(callsAlpha) }).fingerprint)
      .not.toBe(fp(callsBeta, 4, { ast: jsAst(callsBeta) }).fingerprint);
  });

  it('a changed literal invalidates at every level', () => {
    const changed = 'function f(a) {\n  const rate = 999;\n  return a * rate;\n}';
    for (const level of [0, 1, 2, 3, 4] as FingerprintLevel[]) {
      const before = fp(BASE, level, { ast: jsAst(BASE) }).fingerprint;
      const after = fp(changed, level, { ast: jsAst(changed) }).fingerprint;
      expect(before, `level ${level} should detect a literal change`).not.toBe(after);
    }
  });

  it('degrades to L2 and reports it when no AST is available', () => {
    const result = fp(BASE, 4, { language: 'ruby' });
    expect(result.effectiveLevel).toBe(2);
  });

  // Alpha-renaming must apply to variable references only. Property names are
  // part of an object's shape, so renaming them would let genuinely different
  // objects collide.
  describe('L4 name positions are not renamed', () => {
    it('treats object shorthand and explicit form as equal', () => {
      const shorthand = 'function f(a) {\n  const tax = g(a);\n  return { a, tax };\n}';
      const explicit = 'function f(a) {\n  const owed = g(a);\n  return { a, tax: owed };\n}';
      expect(fp(shorthand, 4, { ast: jsAst(shorthand) }).fingerprint)
        .toBe(fp(explicit, 4, { ast: jsAst(explicit) }).fingerprint);
    });

    it('distinguishes different property keys', () => {
      const a = 'function f(x) {\n  return { tax: x };\n}';
      const b = 'function f(x) {\n  return { total: x };\n}';
      expect(fp(a, 4, { ast: jsAst(a) }).fingerprint)
        .not.toBe(fp(b, 4, { ast: jsAst(b) }).fingerprint);
    });

    it('distinguishes different member accesses even when a local shares the name', () => {
      const a = 'function f(o) {\n  const tax = 1;\n  return o.tax + tax;\n}';
      const b = 'function f(o) {\n  const tax = 1;\n  return o.total + tax;\n}';
      expect(fp(a, 4, { ast: jsAst(a) }).fingerprint)
        .not.toBe(fp(b, 4, { ast: jsAst(b) }).fingerprint);
    });
  });

  // Regression: alpha-renaming used to return early on a bound Identifier,
  // which threw away every sibling field on that node. In TypeScript a
  // parameter's type annotation lives on the Identifier itself, so a real
  // signature change became invisible at L4 while L3 still caught it. A more
  // normalized level must never miss a change a less normalized one detects.
  describe('L4 renames identifier names without discarding their other fields', () => {
    it('detects a changed parameter type annotation', () => {
      const a = "function f(mode: 'coding' | 'thinking') {\n  return mode;\n}";
      const b = "function f(mode: 'other' | 'thinking') {\n  return mode;\n}";
      expect(fp(a, 4, { ast: jsAst(a) }).fingerprint)
        .not.toBe(fp(b, 4, { ast: jsAst(b) }).fingerprint);
    });

    it('detects a changed indexed-access type on a renamed parameter', () => {
      const a = "function f(difficulty: Cfg['difficulty'] = 'hard') {\n  return difficulty;\n}";
      const b = "function f(difficulty: Cfg['level'] = 'hard') {\n  return difficulty;\n}";
      expect(fp(a, 4, { ast: jsAst(a) }).fingerprint)
        .not.toBe(fp(b, 4, { ast: jsAst(b) }).fingerprint);
    });

    it('still ignores a pure rename when the annotation is unchanged', () => {
      const a = "function f(mode: 'coding' | 'thinking') {\n  return mode;\n}";
      const b = "function f(kind: 'coding' | 'thinking') {\n  return kind;\n}";
      expect(fp(a, 4, { ast: jsAst(a) }).fingerprint)
        .toBe(fp(b, 4, { ast: jsAst(b) }).fingerprint);
    });
  });

  it('never collides across levels for identical input', () => {
    const seen = new Set<string>();
    for (const level of [0, 1, 2, 3, 4] as FingerprintLevel[]) {
      seen.add(fp(BASE, level, { ast: jsAst(BASE) }).fingerprint);
    }
    expect(seen.size).toBe(5);
  });
});

describe('comment stripping across languages', () => {
  it('strips python comments and docstrings but keeps code', () => {
    const src = 'def f(a):\n    """Docstring here."""\n    # a note\n    return a * 2\n';
    const stripped = stripComments(src, 'python');
    expect(stripped).toContain('return a * 2');
    expect(stripped).not.toContain('Docstring here');
    expect(stripped).not.toContain('a note');
  });

  it('strips C block and line comments', () => {
    const src = 'int f(int a) {\n  /* block */\n  return a; // trailing\n}';
    const stripped = stripComments(src, 'c');
    expect(stripped).toContain('return a;');
    expect(stripped).not.toContain('block');
    expect(stripped).not.toContain('trailing');
  });

  it('preserves hash characters inside shell strings', () => {
    const src = 'echo "value#notcomment" # real comment';
    const stripped = stripComments(src, 'shell');
    expect(stripped).toContain('value#notcomment');
    expect(stripped).not.toContain('real comment');
  });

  it('python comment-only edits produce equal L2 fingerprints', () => {
    const a = 'def f(a):\n    """One."""\n    return a * 2\n';
    const b = 'def f(a):\n    """Something entirely different."""\n    # extra\n    return a * 2\n';
    expect(fp(a, 2, { language: 'python' }).fingerprint)
      .toBe(fp(b, 2, { language: 'python' }).fingerprint);
  });

  it('python literal changes still differ at L2', () => {
    const a = 'def f(a):\n    return a * 2\n';
    const b = 'def f(a):\n    return a * 3\n';
    expect(fp(a, 2, { language: 'python' }).fingerprint)
      .not.toBe(fp(b, 2, { language: 'python' }).fingerprint);
  });
});

describe('fingerprint helpers', () => {
  it('normalizeWhitespace collapses runs and drops blank lines', () => {
    expect(normalizeWhitespace('  a  =  1 \n\n   b=2')).toBe('a = 1\nb=2');
  });

  it('coerceFingerprintLevel accepts numbers, names, and rejects junk', () => {
    expect(coerceFingerprintLevel(0)).toBe(0);
    expect(coerceFingerprintLevel(3)).toBe(3);
    expect(coerceFingerprintLevel('structural')).toBe(3);
    expect(coerceFingerprintLevel('2')).toBe(2);
    expect(coerceFingerprintLevel(99)).toBe(4);
    expect(coerceFingerprintLevel(undefined)).toBe(4);
  });

  it('canonicalizeAst omits position data', () => {
    const canonical = canonicalizeAst(jsAst('const x = 1;'));
    expect(canonical).not.toContain('loc');
    expect(canonical).not.toContain('start');
    expect(canonical).toContain('VariableDeclaration');
  });
});
