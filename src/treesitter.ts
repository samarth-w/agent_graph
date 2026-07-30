/**
 * Tree-sitter backed structural fingerprinting for Python and C/C++.
 *
 * Scope is deliberately narrow: this module supplies *canonical forms* for
 * fingerprinting only. Symbol extraction for these languages stays with the
 * existing regex parsers in `src/parser.ts` — replacing those is a far larger
 * and riskier change than this feature needs.
 *
 * Availability is best-effort. If the WASM runtime or a grammar fails to load,
 * every entry point degrades to `null` and the caller falls back to the
 * text-based L2 fingerprint. Losing structural precision costs us some false
 * positives (knowledge re-derived unnecessarily); it never causes a missed
 * invalidation, so failing this way is safe.
 *
 * Version coupling note: the prebuilt grammars in `tree-sitter-wasms` are
 * compiled by an older tree-sitter CLI and are rejected by newer runtimes with
 * an opaque dylink error. Both packages are therefore pinned exactly.
 */
import path from 'path';
import Parser from 'web-tree-sitter';
import type { FingerprintLevel } from './fingerprint';

export type TsGrammarId = 'python' | 'c' | 'cpp';

const GRAMMAR_BY_LANGUAGE: Record<string, TsGrammarId> = {
  python: 'python',
  c: 'c',
  cpp: 'cpp',
};

/** Grammar backing a cgraph language id, or null when there is no AST provider. */
export function treeSitterGrammarFor(language: string): TsGrammarId | null {
  return GRAMMAR_BY_LANGUAGE[language] ?? null;
}

// ─── runtime loading ────────────────────────────────────────────

type AnyParser = {
  setLanguage(lang: unknown): void;
  parse(src: string): { rootNode: TsNode; delete(): void };
};

/** Minimal structural view of a tree-sitter node; avoids leaning on runtime typings. */
interface TsNode {
  type: string;
  text: string;
  isNamed: boolean;
  childCount: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  child(i: number): TsNode | null;
  fieldNameForChild(i: number): string | null;
  descendantForPosition(start: { row: number; column: number }, end: { row: number; column: number }): TsNode;
}

const parsers = new Map<TsGrammarId, AnyParser>();
let initPromise: Promise<boolean> | null = null;
let runtimeUnavailable = false;

function grammarWasmPath(id: TsGrammarId): string {
  const pkgJson = require.resolve('tree-sitter-wasms/package.json');
  return path.join(path.dirname(pkgJson), 'out', `tree-sitter-${id}.wasm`);
}

/**
 * Load the WASM runtime and grammars. Idempotent and safe to call concurrently.
 * Must be awaited before any synchronous canonicalization, because parsing
 * itself is sync but loading is not.
 */
export function initTreeSitter(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await (Parser as any).init();
      for (const id of Object.values(GRAMMAR_BY_LANGUAGE)) {
        if (parsers.has(id)) continue;
        try {
          const lang = await (Parser as any).Language.load(grammarWasmPath(id));
          const p = new (Parser as any)() as AnyParser;
          p.setLanguage(lang);
          parsers.set(id, p);
        } catch {
          // One missing grammar must not disable the others.
        }
      }
      runtimeUnavailable = parsers.size === 0;
      return !runtimeUnavailable;
    } catch {
      runtimeUnavailable = true;
      return false;
    }
  })();
  return initPromise;
}

export function isTreeSitterReady(language: string): boolean {
  const id = treeSitterGrammarFor(language);
  return id !== null && !runtimeUnavailable && parsers.has(id);
}

// ─── binding collection (for alpha-renaming at L4) ──────────────

/**
 * Positions where an identifier names a member, keyword, or the symbol itself
 * rather than referencing a binding. These must never be alpha-renamed: in
 * Python both `o.tax` and `f(key=…)` use plain `identifier` nodes, so a local
 * variable that happens to share the name would otherwise collapse `o.tax` and
 * `o.total` into the same fingerprint — a missed invalidation.
 */
function isNamePosition(parentType: string, field: string | null, childType: string): boolean {
  if (childType === 'field_identifier' || childType === 'property_identifier') return true;
  if (parentType === 'attribute' && field === 'attribute') return true;
  if (parentType === 'keyword_argument' && field === 'name') return true;
  if (parentType === 'field_expression' && field === 'field') return true;
  if (parentType === 'function_definition' && field === 'name') return true;
  if (parentType === 'function_declarator' && field === 'declarator') return true;
  return false;
}

function childByField(node: TsNode, field: string): TsNode | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === field) return node.child(i);
  }
  return null;
}

function eachChild(node: TsNode, fn: (child: TsNode, field: string | null, index: number) => void): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) fn(child, node.fieldNameForChild(i), i);
  }
}

/** Record every plain identifier inside a binding target pattern. */
function bindPattern(node: TsNode | null, bind: (name: string) => void): void {
  if (!node) return;
  if (node.type === 'identifier') {
    bind(node.text);
    return;
  }
  // Tuple/list destructuring, splats, pointers, arrays, references, defaults.
  eachChild(node, (child, field) => {
    if (field === 'type') return; // C declarations: the type is not a binding
    bindPattern(child, bind);
  });
}

function collectPythonBindings(node: TsNode, bind: (name: string) => void): void {
  switch (node.type) {
    case 'function_definition':
    case 'lambda': {
      const params = childByField(node, 'parameters');
      if (params) {
        eachChild(params, (child) => {
          if (!child.isNamed) return;
          if (child.type === 'identifier') bind(child.text);
          else bindPattern(childByField(child, 'name') ?? child, bind);
        });
      }
      break;
    }
    case 'assignment':
    case 'augmented_assignment':
    case 'for_statement':
    case 'for_in_clause':
      bindPattern(childByField(node, 'left'), bind);
      break;
    case 'as_pattern_target':
      bindPattern(node, bind);
      break;
    case 'named_expression':
      bindPattern(childByField(node, 'name'), bind);
      break;
    default:
      break;
  }
}

function collectCBindings(node: TsNode, bind: (name: string) => void): void {
  if (node.type === 'parameter_declaration') {
    bindPattern(childByField(node, 'declarator'), bind);
    return;
  }
  if (node.type === 'declaration') {
    // Only local variables. `function_declarator` children are call signatures,
    // not bindings, so they are skipped by bindPattern's field filtering below.
    eachChild(node, (child, field) => {
      if (field !== 'declarator') return;
      if (child.type === 'function_declarator') return;
      const target = child.type === 'init_declarator' ? childByField(child, 'declarator') : child;
      if (target && target.type !== 'function_declarator') bindPattern(target, bind);
    });
  }
}

function collectBindings(root: TsNode, grammar: TsGrammarId): Map<string, string> {
  const bindings = new Map<string, string>();
  const bind = (name: string): void => {
    if (!name || bindings.has(name)) return;
    bindings.set(name, `$v${bindings.size}`);
  };
  const walk = (node: TsNode): void => {
    if (node.type === 'comment') return;
    if (grammar === 'python') collectPythonBindings(node, bind);
    else collectCBindings(node, bind);
    eachChild(node, (child) => walk(child));
  };
  walk(root);
  return bindings;
}

// ─── canonicalization ───────────────────────────────────────────

/** A leading bare-string statement is a docstring: documentation, not behavior. */
function isDocstring(node: TsNode): boolean {
  if (node.type !== 'expression_statement') return false;
  let onlyNamed: TsNode | null = null;
  let namedCount = 0;
  eachChild(node, (child) => {
    if (!child.isNamed) return;
    namedCount++;
    onlyNamed = child;
  });
  return namedCount === 1 && onlyNamed !== null && (onlyNamed as TsNode).type === 'string';
}

function canonicalizeNode(
  node: TsNode,
  bindings: Map<string, string> | null,
  namePosition: boolean,
): string | null {
  if (node.type === 'comment') return null;

  if (node.childCount === 0) {
    // Anonymous leaves are operators and punctuation, where the node type *is*
    // the source text. Dropping them would make `a + b` and `a - b` identical.
    if (!node.isNamed) return `(${node.type})`;
    if (bindings && !namePosition && node.type === 'identifier') {
      const slot = bindings.get(node.text);
      if (slot) return `(identifier ${slot})`;
    }
    return `(${node.type} ${JSON.stringify(node.text)})`;
  }

  const parts: string[] = [];
  const skipsDocstring = node.type === 'block' || node.type === 'module';
  let seenNamed = false;

  eachChild(node, (child, field) => {
    if (child.type === 'comment') return;
    if (skipsDocstring && !seenNamed && child.isNamed && isDocstring(child)) {
      seenNamed = true;
      return;
    }
    if (child.isNamed) seenNamed = true;
    const canonical = canonicalizeNode(
      child,
      bindings,
      isNamePosition(node.type, field, child.type),
    );
    if (canonical === null) return;
    parts.push(field ? `${field}:${canonical}` : canonical);
  });

  return `(${node.type}${parts.length ? ' ' + parts.join(' ') : ''})`;
}

// ─── public surface ─────────────────────────────────────────────

export interface TsFileTree {
  /** Canonical form of the symbol spanning the given 1-based inclusive lines. */
  canonicalizeSymbol(startLine: number, endLine: number, level: FingerprintLevel): string | null;
  dispose(): void;
}

/**
 * Parse a whole file once so every symbol in it can be canonicalized without
 * re-parsing. Returns null when the language has no grammar loaded.
 */
export function createFileTree(content: string, language: string): TsFileTree | null {
  const id = treeSitterGrammarFor(language);
  if (!id || runtimeUnavailable) return null;
  const parser = parsers.get(id);
  if (!parser) return null;

  let tree: { rootNode: TsNode; delete(): void } | null;
  try {
    tree = parser.parse(content);
  } catch {
    return null;
  }
  if (!tree) return null;
  const root = tree.rootNode;
  const lastRow = root.endPosition.row;

  return {
    canonicalizeSymbol(startLine, endLine, level) {
      if (level < 3) return null;
      try {
        const startRow = Math.max(0, Math.min(lastRow, startLine - 1));
        const endRow = Math.max(startRow, Math.min(lastRow, endLine - 1));
        // Smallest node spanning the symbol's line range. When the regex
        // extractor's range is imprecise this widens to an enclosing node,
        // which only makes the fingerprint coarser — never unsound.
        const node = root.descendantForPosition(
          { row: startRow, column: 0 },
          { row: endRow, column: 0 },
        );
        if (!node) return null;
        const bindings = level >= 4 ? collectBindings(node, id) : null;
        return canonicalizeNode(node, bindings, false);
      } catch {
        return null;
      }
    },
    dispose() {
      try {
        tree?.delete();
      } catch {
        /* freeing WASM memory is best-effort */
      }
      tree = null;
    },
  };
}
