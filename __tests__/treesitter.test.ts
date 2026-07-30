import { describe, it, expect, beforeAll } from 'vitest';
import { computeFingerprint } from '../src/fingerprint';
import { createFileTree, initTreeSitter, isTreeSitterReady } from '../src/treesitter';

/** Fingerprint a whole-file symbol using the tree-sitter canonical form. */
function fp(source: string, language: string, level: 3 | 4 = 4): string {
  const tree = createFileTree(source, language);
  const lines = source.split('\n').length;
  const canonicalAst = tree?.canonicalizeSymbol(1, lines, level) ?? undefined;
  try {
    return computeFingerprint({
      identity: 'sym\u0000function',
      body: source,
      language,
      level,
      canonicalAst,
    }).fingerprint;
  } finally {
    tree?.dispose();
  }
}

function canon(source: string, language: string, level: 3 | 4 = 4): string | null {
  const tree = createFileTree(source, language);
  try {
    return tree?.canonicalizeSymbol(1, source.split('\n').length, level) ?? null;
  } finally {
    tree?.dispose();
  }
}

describe('tree-sitter structural fingerprints', () => {
  beforeAll(async () => {
    await initTreeSitter();
  });

  it('loads grammars for python, c, and cpp', () => {
    expect(isTreeSitterReady('python')).toBe(true);
    expect(isTreeSitterReady('c')).toBe(true);
    expect(isTreeSitterReady('cpp')).toBe(true);
    expect(isTreeSitterReady('ruby')).toBe(false);
  });

  describe('python', () => {
    const base = 'def f(a):\n    rate = 2\n    return a * rate\n';

    it('ignores reformatting', () => {
      const reformatted = 'def f(a):\n\n        rate   =   2\n\n        return a  *  rate\n';
      expect(fp(reformatted, 'python')).toBe(fp(base, 'python'));
    });

    it('ignores comment and docstring edits', () => {
      const commented = 'def f(a):\n    """Compute a scaled value."""\n    # scale factor\n    rate = 2\n    return a * rate\n';
      const recommented = 'def f(a):\n    """Totally different prose here."""\n    # changed note\n    rate = 2\n    return a * rate\n';
      expect(fp(commented, 'python')).toBe(fp(recommented, 'python'));
    });

    it('ignores a local rename at L4 but not at L3', () => {
      const renamed = 'def f(a):\n    factor = 2\n    return a * factor\n';
      expect(fp(renamed, 'python', 4)).toBe(fp(base, 'python', 4));
      expect(fp(renamed, 'python', 3)).not.toBe(fp(base, 'python', 3));
    });

    it('detects a changed literal', () => {
      const changed = 'def f(a):\n    rate = 3\n    return a * rate\n';
      expect(fp(changed, 'python')).not.toBe(fp(base, 'python'));
    });

    it('detects a changed operator', () => {
      const changed = 'def f(a):\n    rate = 2\n    return a + rate\n';
      expect(fp(changed, 'python')).not.toBe(fp(base, 'python'));
    });

    it('keeps distinct attribute names distinct even when a local shares the name', () => {
      // `tax` is both a local binding and an attribute name here. Renaming the
      // attribute would collapse these two different field reads.
      const readsTax = 'def f(o):\n    tax = 1\n    return o.tax + tax\n';
      const readsTotal = 'def f(o):\n    tax = 1\n    return o.total + tax\n';
      expect(fp(readsTax, 'python')).not.toBe(fp(readsTotal, 'python'));
    });

    it('keeps distinct keyword-argument names distinct', () => {
      const a = 'def f(b):\n    key = 1\n    return g(key=b)\n';
      const c = 'def f(b):\n    key = 1\n    return g(other=b)\n';
      expect(fp(a, 'python')).not.toBe(fp(c, 'python'));
    });

    it('keeps distinct called function names distinct', () => {
      const a = 'def f(x):\n    return alpha(x)\n';
      const b = 'def f(x):\n    return beta(x)\n';
      expect(fp(a, 'python')).not.toBe(fp(b, 'python'));
    });

    it('renames locals to positional slots in the canonical form', () => {
      const text = canon('def f(a):\n    rate = 2\n    return a * rate\n', 'python', 4);
      expect(text).toContain('$v0');
      expect(text).toContain('$v1');
      expect(text).not.toContain('"rate"');
    });
  });

  describe('c and cpp', () => {
    const base = 'int add(int a, int b) {\n  int s = a + b;\n  return s;\n}\n';

    it('ignores reformatting and comments', () => {
      const other = 'int add(int a,int b){\n  /* sum them */\n  int s=a+b;\n  // done\n  return s;\n}\n';
      expect(fp(other, 'c')).toBe(fp(base, 'c'));
    });

    it('ignores a local rename at L4', () => {
      const renamed = 'int add(int a, int b) {\n  int total = a + b;\n  return total;\n}\n';
      expect(fp(renamed, 'c', 4)).toBe(fp(base, 'c', 4));
    });

    it('detects a changed operator', () => {
      const changed = 'int add(int a, int b) {\n  int s = a - b;\n  return s;\n}\n';
      expect(fp(changed, 'c')).not.toBe(fp(base, 'c'));
    });

    it('keeps distinct struct field names distinct', () => {
      const a = 'int f(S *p) {\n  int field = 0;\n  return p->field + field;\n}\n';
      const b = 'int f(S *p) {\n  int field = 0;\n  return p->other + field;\n}\n';
      expect(fp(a, 'c')).not.toBe(fp(b, 'c'));
    });

    it('canonicalizes cpp as well', () => {
      const cpp = 'int add(int a, int b) {\n  int s = a + b;\n  return s;\n}\n';
      expect(canon(cpp, 'cpp', 4)).toBeTruthy();
    });
  });

  describe('graceful degradation', () => {
    it('returns null for a language with no grammar', () => {
      expect(createFileTree('puts "hi"\n', 'ruby')).toBeNull();
    });

    it('falls back to the text fingerprint when no canonical form exists', () => {
      const result = computeFingerprint({
        identity: 'x\u0000function',
        body: 'puts "hi"\n',
        language: 'ruby',
        level: 4,
      });
      expect(result.effectiveLevel).toBe(2);
    });
  });
});
