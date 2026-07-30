/**
 * Semantic fingerprinting with graded normalization levels.
 *
 * A fingerprint answers: "did this symbol change in a way that could invalidate
 * knowledge derived from it?" The answer depends on how aggressively we
 * normalize away edits that carry no semantic weight.
 *
 *   L0 raw        — exact bytes. Any edit at all invalidates.
 *   L1 whitespace — re-indentation and blank lines are ignored.
 *   L2 comments   — comment and docstring edits are ignored.
 *   L3 structural — AST-canonical: formatting, comments, and punctuation
 *                   placement are ignored; literals and identifiers are kept.
 *   L4 alpha      — L3 plus local identifiers renamed to positional slots, so
 *                   renaming a local variable is not a semantic change.
 *
 * Levels are cumulative: each subsumes the ones below it. L3+ requires a real
 * parse tree, so it is only available for languages with an AST provider.
 * Languages without one silently degrade to L2, which is reported in the
 * result so callers can tell a true L4 fingerprint from a degraded one.
 */
import crypto from 'crypto';

export type FingerprintLevel = 0 | 1 | 2 | 3 | 4;

export const DEFAULT_FINGERPRINT_LEVEL: FingerprintLevel = 4;

export const FINGERPRINT_LEVEL_NAMES: Record<FingerprintLevel, string> = {
  0: 'raw',
  1: 'whitespace',
  2: 'comments',
  3: 'structural',
  4: 'alpha',
};

/** Parse the configured level, falling back to the default when unset/invalid. */
export function coerceFingerprintLevel(value: unknown): FingerprintLevel {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4) {
    return value as FingerprintLevel;
  }
  if (typeof value === 'string') {
    const byName = (Object.keys(FINGERPRINT_LEVEL_NAMES) as Array<`${FingerprintLevel}`>)
      .find((key) => FINGERPRINT_LEVEL_NAMES[Number(key) as FingerprintLevel] === value);
    if (byName !== undefined) return Number(byName) as FingerprintLevel;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 4) return parsed as FingerprintLevel;
  }
  return DEFAULT_FINGERPRINT_LEVEL;
}

// ─── comment stripping ──────────────────────────────────────────

type CommentSyntax = {
  line: string[];
  blockOpen?: string;
  blockClose?: string;
  quotes: string[];
  /** Triple-quoted docstrings (Python). */
  tripleQuotes?: string[];
};

function commentSyntaxFor(language: string): CommentSyntax | null {
  switch (language) {
    case 'javascript':
    case 'typescript':
    case 'jsx':
    case 'tsx':
    case 'c':
    case 'cpp':
      return { line: ['//'], blockOpen: '/*', blockClose: '*/', quotes: ['"', "'", '`'] };
    case 'python':
      return { line: ['#'], quotes: ['"', "'"], tripleQuotes: ['"""', "'''"] };
    case 'shell':
    case 'bash':
    case 'yaml':
    case 'powershell':
      return { line: ['#'], quotes: ['"', "'"] };
    case 'nasm':
    case 'asl':
      return { line: [';'], blockOpen: '/*', blockClose: '*/', quotes: ['"', "'"] };
    case 'batch':
      return { line: ['::', 'REM ', 'rem '], quotes: ['"'] };
    default:
      return null;
  }
}

/**
 * Remove comments while preserving string literals.
 *
 * This is a character scanner rather than a regex because comment markers
 * appear inside strings constantly (URLs contain `//`, shell strings contain
 * `#`), and stripping those would corrupt otherwise-identical bodies.
 */
export function stripComments(source: string, language: string): string {
  const syntax = commentSyntaxFor(language);
  if (!syntax) return source;

  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    // Triple-quoted strings (Python docstrings) must be matched before single quotes.
    let matchedTriple = false;
    for (const triple of syntax.tripleQuotes ?? []) {
      if (source.startsWith(triple, i)) {
        const close = source.indexOf(triple, i + triple.length);
        const end = close === -1 ? n : close + triple.length;
        // Preserve newlines so line-based slicing downstream stays aligned.
        out += source.slice(i, end).replace(/[^\n]/g, ' ');
        i = end;
        matchedTriple = true;
        break;
      }
    }
    if (matchedTriple) continue;

    const ch = source[i];

    // String literal — copy verbatim, honouring escapes.
    if (syntax.quotes.includes(ch)) {
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }

    // Block comment.
    if (syntax.blockOpen && source.startsWith(syntax.blockOpen, i)) {
      const close = source.indexOf(syntax.blockClose!, i + syntax.blockOpen.length);
      const end = close === -1 ? n : close + syntax.blockClose!.length;
      out += source.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }

    // Line comment.
    const lineMarker = syntax.line.find((marker) => source.startsWith(marker, i));
    if (lineMarker) {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      i = end;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Collapse whitespace runs and drop blank lines. */
export function normalizeWhitespace(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// ─── AST canonicalization ───────────────────────────────────────

/** Node fields that carry no semantic meaning and must never affect a fingerprint. */
const IGNORED_AST_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra', 'errors', 'tokens', 'comments',
  'leadingComments', 'trailingComments', 'innerComments', 'parent',
  // `{ a }` and `{ a: a }` are the same object; shorthand is pure syntax.
  'shorthand',
]);

const MEMBER_TYPES = new Set(['MemberExpression', 'OptionalMemberExpression']);
const KEYED_MEMBER_TYPES = new Set([
  'ObjectProperty', 'ObjectMethod', 'ClassMethod', 'ClassProperty',
  'ClassPrivateMethod', 'ClassPrivateProperty', 'TSPropertySignature',
  'TSMethodSignature',
]);

/**
 * True when a child sits in a "name position" — it denotes a property or label
 * rather than a variable reference.
 *
 * This matters for alpha-renaming: in `{ tax }` or `obj.tax`, the identifier
 * `tax` is part of the object's shape, not a local binding. Renaming it would
 * make `obj.tax` and `obj.total` collide whenever a local happened to share the
 * name, which is both unsound and a source of missed invalidations.
 */
function isNamePosition(node: any, key: string): boolean {
  if (key === 'property' && MEMBER_TYPES.has(node.type)) return !node.computed;
  if (key === 'key' && KEYED_MEMBER_TYPES.has(node.type)) return !node.computed;
  if (key === 'label') return true;
  if (key === 'imported' || key === 'exported') return true;
  return false;
}

/**
 * Walk a subtree and assign positional slots to locally-declared identifiers.
 *
 * Only bindings introduced *inside* the symbol are renamed. References to
 * outside names (imported functions, globals, called symbols) keep their real
 * names, because those are exactly the edges the dependency graph relies on —
 * renaming them would make unrelated symbols collide.
 */
function collectLocalBindings(node: any, bindings: Map<string, string> = new Map()): Map<string, string> {
  if (!node || typeof node !== 'object') return bindings;

  const declare = (target: any): void => {
    if (!target || typeof target !== 'object') return;
    switch (target.type) {
      case 'Identifier':
        if (target.name && !bindings.has(target.name)) {
          bindings.set(target.name, `$v${bindings.size}`);
        }
        return;
      case 'ObjectPattern':
        for (const prop of target.properties ?? []) declare(prop.value ?? prop.argument ?? prop);
        return;
      case 'ArrayPattern':
        for (const element of target.elements ?? []) declare(element);
        return;
      case 'AssignmentPattern':
        declare(target.left);
        return;
      case 'RestElement':
        declare(target.argument);
        return;
      default:
        return;
    }
  };

  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ObjectMethod':
      for (const param of node.params ?? []) declare(param);
      break;
    case 'VariableDeclarator':
      declare(node.id);
      break;
    case 'CatchClause':
      declare(node.param);
      break;
    default:
      break;
  }

  for (const key of Object.keys(node)) {
    if (IGNORED_AST_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) collectLocalBindings(item, bindings);
      }
    } else if (child && typeof child === 'object' && child.type) {
      collectLocalBindings(child, bindings);
    }
  }

  return bindings;
}

/**
 * Serialize an AST subtree to a canonical string.
 *
 * Uses a denylist rather than an allowlist of node fields so that operators,
 * literal values, and flags like `computed` are all captured automatically —
 * an allowlist would silently miss semantic fields on node types we forgot.
 */
export function canonicalizeAst(node: any, bindings?: Map<string, string>): string {
  if (node === null || node === undefined) return '#';
  if (Array.isArray(node)) return `[${node.map((item) => canonicalizeAst(item, bindings)).join(',')}]`;

  if (typeof node !== 'object') {
    return typeof node === 'string' ? JSON.stringify(node) : String(node);
  }
  if (!node.type) return '#';

  const parts: string[] = [node.type];
  for (const key of Object.keys(node).sort()) {
    if (key === 'type' || IGNORED_AST_KEYS.has(key)) continue;
    const value = node[key];
    if (value === undefined) continue;

    // Alpha-renaming replaces the *name* of a locally-bound identifier and
    // nothing else. It must not short-circuit the rest of the node: in
    // TypeScript a parameter's `typeAnnotation` hangs off the very same
    // Identifier, so returning early here would silently discard the
    // parameter's type. That hid real signature changes such as
    // `mode: 'coding' | 'thinking'` -> `mode: 'other' | 'thinking'`, which is
    // a missed invalidation — the one failure direction that actually harms
    // correctness.
    if (node.type === 'Identifier' && key === 'name' && bindings?.has(value)) {
      parts.push(`name=${bindings.get(value)}`);
      continue;
    }

    // Identifiers in name positions keep their real names.
    const childBindings = isNamePosition(node, key) ? undefined : bindings;

    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        parts.push(`${key}=${canonicalizeAst(value, childBindings)}`);
      } else if (value.type) {
        parts.push(`${key}=${canonicalizeAst(value, childBindings)}`);
      }
      continue;
    }
    if (typeof value === 'function') continue;
    parts.push(`${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return `(${parts.join(' ')})`;
}

// ─── fingerprint computation ────────────────────────────────────

export interface FingerprintInput {
  /** Stable symbol identity (qualified name, kind, signature). */
  identity: string;
  /** Raw source text of the symbol body. */
  body: string;
  language: string;
  level: FingerprintLevel;
  /** Parse tree for the symbol, when the language has an AST provider. */
  astNode?: unknown;
  /**
   * Already-canonicalized structural form, for AST providers that do not
   * expose a plain-object tree (tree-sitter's WASM nodes, for example).
   * Takes precedence over `astNode`.
   */
  canonicalAst?: string;
}

export interface FingerprintResult {
  fingerprint: string;
  /** Level actually applied — lower than requested when no AST was available. */
  effectiveLevel: FingerprintLevel;
  /** Canonical form that was hashed. Useful for debugging and tests. */
  canonical: string;
}

/** Reduce a symbol to a canonical form at the requested level, then hash it. */
export function computeFingerprint(input: FingerprintInput): FingerprintResult {
  const { identity, body, language, level, astNode, canonicalAst } = input;

  let effectiveLevel = level;
  let canonical: string;

  if (level >= 3 && canonicalAst) {
    canonical = canonicalAst;
  } else if (level >= 3 && astNode) {
    const bindings = level >= 4 ? collectLocalBindings(astNode) : undefined;
    canonical = canonicalizeAst(astNode, bindings);
  } else {
    // No AST available — degrade to the best text-based level.
    if (level >= 3) effectiveLevel = 2;

    if (effectiveLevel === 0) {
      canonical = body;
    } else if (effectiveLevel === 1) {
      canonical = normalizeWhitespace(body);
    } else {
      canonical = normalizeWhitespace(stripComments(body, language));
    }
  }

  const payload = `${effectiveLevel}\u0000${identity}\u0000${canonical}`;
  return {
    fingerprint: crypto.createHash('sha256').update(payload).digest('hex'),
    effectiveLevel,
    canonical,
  };
}
