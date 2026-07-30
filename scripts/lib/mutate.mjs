/**
 * Mutation engine for invalidation ground truth.
 *
 * Generates labeled edits to real source files so invalidation accuracy can be
 * measured without hand-labeling:
 *
 *   semantic-PRESERVING → the symbol's computation is unchanged, so knowledge
 *                         derived from it stays valid. Invalidating is a FALSE
 *                         POSITIVE (cost hazard: the agent re-derives).
 *   semantic-CHANGING   → the computation differs, so derived knowledge may be
 *                         wrong. Failing to invalidate is a FALSE NEGATIVE
 *                         (correctness hazard: the agent acts on a stale belief).
 *
 * METHODOLOGY NOTE — independence: this engine is built on tree-sitter for all
 * languages, including JS/TS, where the system under test uses Babel. Sharing a
 * parser with the implementation would let a canonicalization bug cancel itself
 * out and inflate the measured score.
 *
 * SCOPE NOTE: mutations are evaluated statically. "Semantic change" here means
 * the computed expression differs, not that observable runtime behavior differs
 * on some input. Mutated code is never executed.
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Parser = require('web-tree-sitter');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** cgraph language id → tree-sitter grammar name. */
const GRAMMARS = {
  javascript: 'javascript',
  jsx: 'javascript',
  typescript: 'typescript',
  tsx: 'typescript',
  python: 'python',
  c: 'c',
  cpp: 'cpp',
};

const EXT_LANGUAGE = {
  '.js': 'javascript', '.mjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
};

export function languageForFile(file) {
  return EXT_LANGUAGE[path.extname(file).toLowerCase()] ?? null;
}

const parsers = new Map();

export async function initMutator() {
  if (parsers.size) return;
  await Parser.init();
  for (const grammar of new Set(Object.values(GRAMMARS))) {
    const wasm = path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${grammar}.wasm`);
    const lang = await Parser.Language.load(wasm);
    const p = new Parser();
    p.setLanguage(lang);
    parsers.set(grammar, p);
  }
}

function parse(source, language) {
  const grammar = GRAMMARS[language];
  const parser = grammar && parsers.get(grammar);
  if (!parser) throw new Error(`no grammar for language "${language}"`);
  return parser.parse(source);
}

// ─── traversal helpers ──────────────────────────────────────────

function* walk(node) {
  yield node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) yield* walk(child);
  }
}

function fieldChild(node, field) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === field) return node.child(i);
  }
  return null;
}

const FUNCTION_TYPES = new Set([
  'function_definition', 'function_declaration', 'method_definition',
  'function_item', 'method_declaration',
]);

function functionName(node) {
  const direct = fieldChild(node, 'name');
  if (direct) return direct.text;
  // C/C++: the name sits under declarator: function_declarator > declarator.
  let declarator = fieldChild(node, 'declarator');
  while (declarator) {
    if (declarator.type === 'identifier') return declarator.text;
    declarator = fieldChild(declarator, 'declarator');
  }
  return null;
}

/** Named functions in a file, in source order, with unique names only. */
export function collectSymbols(source, language) {
  const tree = parse(source, language);
  const found = [];
  const seen = new Map();
  for (const node of walk(tree.rootNode)) {
    if (!FUNCTION_TYPES.has(node.type)) continue;
    const name = functionName(node);
    if (!name) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    found.push({
      name,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      text: node.text,
    });
  }
  tree.delete();
  // Overloads and same-named nested helpers cannot be matched across a
  // mutation by name alone, so they are excluded rather than mislabeled.
  return found.filter((s) => seen.get(s.name) === 1);
}

// ─── identifier classification ──────────────────────────────────

/**
 * True when an identifier names a member/keyword rather than referencing a
 * binding. Renaming these would change which field or parameter is addressed,
 * turning a "preserving" mutation into a silently changing one.
 */
function isMemberName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (node.type === 'field_identifier' || node.type === 'property_identifier') return true;
  const field = (() => {
    for (let i = 0; i < parent.childCount; i++) {
      if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
    }
    return null;
  })();
  if (parent.type === 'attribute' && field === 'attribute') return true;
  if (parent.type === 'keyword_argument' && field === 'name') return true;
  if (parent.type === 'field_expression' && field === 'field') return true;
  if (parent.type === 'member_expression' && field === 'property') return true;
  if (parent.type === 'pair' && field === 'key') return true;
  if (FUNCTION_TYPES.has(parent.type) && field === 'name') return true;
  if (parent.type === 'call' || parent.type === 'call_expression') {
    if (field === 'function') return true;
  }
  return false;
}

/** Local binding names declared inside a function node. */
function localBindings(fnNode, language) {
  const names = new Set();
  for (const node of walk(fnNode)) {
    if (language === 'python') {
      if (node.type === 'assignment') {
        const left = fieldChild(node, 'left');
        if (left?.type === 'identifier') names.add(left.text);
      }
    } else if (language === 'c' || language === 'cpp') {
      if (node.type === 'init_declarator') {
        const d = fieldChild(node, 'declarator');
        if (d?.type === 'identifier') names.add(d.text);
      }
    } else if (node.type === 'variable_declarator') {
      const n = fieldChild(node, 'name');
      if (n?.type === 'identifier') names.add(n.text);
    }
  }
  return [...names];
}

// ─── mutation catalogue ─────────────────────────────────────────

const COMMENT_PREFIX = { python: '#', javascript: '//', typescript: '//', c: '//', cpp: '//' };

const OPERATOR_SWAPS = {
  '+': '-', '-': '+', '*': '/', '/': '*',
  '<': '>', '>': '<', '<=': '>=', '>=': '<=',
  '==': '!=', '!=': '==', '===': '!==', '!==': '===',
  '&&': '||', '||': '&&', 'and': 'or', 'or': 'and',
};

const LITERAL_TYPES = new Set([
  'integer', 'float', 'number', 'number_literal',
  'string', 'string_literal',
]);

const BINARY_TYPES = new Set(['binary_operator', 'binary_expression', 'comparison_operator', 'boolean_operator']);

function lineIndent(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const m = /^[ \t]*/.exec(source.slice(lineStart));
  return { lineStart, indent: m ? m[0] : '' };
}

/**
 * Enumerate every mutation applicable to one function.
 * Returns [{ kind, semanticPreserving, edits: [{start, end, replacement}] }].
 */
function mutationsFor(source, language, fnNode) {
  const out = [];
  const nodes = [...walk(fnNode)];
  const add = (kind, semanticPreserving, edits) => {
    if (edits.length) out.push({ kind, semanticPreserving, edits });
  };

  const body = fieldChild(fnNode, 'body');
  const firstStatement = body && body.namedChildCount > 0 ? body.namedChild(0) : null;

  // ── preserving ──
  if (firstStatement) {
    const { lineStart, indent } = lineIndent(source, firstStatement.startIndex);
    const prefix = COMMENT_PREFIX[language] ?? '//';
    add('add_comment', true, [
      { start: lineStart, end: lineStart, replacement: `${indent}${prefix} generated note: explains intent\n` },
    ]);
    add('blank_line', true, [{ start: lineStart, end: lineStart, replacement: '\n' }]);
  }

  const comment = nodes.find((n) => n.type === 'comment');
  if (comment) {
    const prefix = COMMENT_PREFIX[language] ?? '//';
    add('edit_comment', true, [
      { start: comment.startIndex, end: comment.endIndex, replacement: `${prefix} rewritten commentary` },
    ]);
  }

  const binary = nodes.find((n) => BINARY_TYPES.has(n.type) && fieldChild(n, 'left') && fieldChild(n, 'right'));
  if (binary) {
    const left = fieldChild(binary, 'left');
    const right = fieldChild(binary, 'right');
    // Widen the gap around the operator: pure formatting, no token changes.
    add('respace_operator', true, [
      { start: left.endIndex, end: right.startIndex, replacement: `  ${source.slice(left.endIndex, right.startIndex).trim()}  ` },
    ]);
    const opText = source.slice(left.endIndex, right.startIndex).trim();
    const swapped = OPERATOR_SWAPS[opText];
    if (swapped) {
      add('change_operator', false, [
        { start: left.endIndex, end: right.startIndex, replacement: ` ${swapped} ` },
      ]);
    }
  }

  const bindings = localBindings(fnNode, language);
  if (bindings.length) {
    const target = bindings[0];
    const fresh = `${target}_renamed`;
    if (!source.includes(fresh)) {
      const edits = nodes
        .filter((n) => n.type === 'identifier' && n.text === target && !isMemberName(n))
        .map((n) => ({ start: n.startIndex, end: n.endIndex, replacement: fresh }));
      add('rename_local', true, edits);
    }
  }

  // ── changing ──
  const literal = nodes.find((n) => LITERAL_TYPES.has(n.type));
  if (literal) {
    const text = literal.text;
    let replacement = null;
    if (/^-?\d+$/.test(text)) replacement = String(Number(text) + 1);
    else if (/^-?\d*\.\d+$/.test(text)) replacement = String(Number(text) + 1);
    else if (/^(['"]).*\1$/s.test(text)) {
      const q = text[0];
      replacement = `${q}mutated_${text.slice(1, -1)}${q}`;
    }
    if (replacement !== null && replacement !== text) {
      add('change_literal', false, [
        { start: literal.startIndex, end: literal.endIndex, replacement },
      ]);
    }
    // Quote-style swap is preserving when the body contains neither quote char.
    if (/^"[^"'\\\n]*"$/.test(text) && language !== 'c' && language !== 'cpp') {
      add('quote_style', true, [
        { start: literal.startIndex, end: literal.endIndex, replacement: `'${text.slice(1, -1)}'` },
      ]);
    }
  }

  const ifNode = nodes.find((n) => n.type === 'if_statement');
  const condition = ifNode ? fieldChild(ifNode, 'condition') : null;
  if (condition) {
    const negate = language === 'python' ? `not (${condition.text})` : `!(${condition.text})`;
    add('negate_condition', false, [
      { start: condition.startIndex, end: condition.endIndex, replacement: negate },
    ]);
  }

  const ret = nodes.find((n) => n.type === 'return_statement' && n.namedChildCount > 0);
  if (ret) {
    const value = ret.namedChild(0);
    if (value && value.text !== '0' && value.type !== 'comment') {
      add('change_return', false, [
        { start: value.startIndex, end: value.endIndex, replacement: `-(${value.text})` },
      ]);
    }
  }

  const call = nodes.find((n) => {
    if (n.type !== 'call' && n.type !== 'call_expression') return false;
    const args = fieldChild(n, 'arguments');
    if (!args) return false;
    const named = [];
    for (let i = 0; i < args.namedChildCount; i++) named.push(args.namedChild(i));
    return named.length >= 2 && named[0].text !== named[1].text;
  });
  if (call) {
    const args = fieldChild(call, 'arguments');
    const a = args.namedChild(0);
    const b = args.namedChild(1);
    add('swap_args', false, [
      { start: a.startIndex, end: a.endIndex, replacement: b.text },
      { start: b.startIndex, end: b.endIndex, replacement: a.text },
    ]);
  }

  const callStatement = nodes.find(
    (n) => n.type === 'expression_statement' &&
      n.namedChildCount === 1 &&
      ['call', 'call_expression'].includes(n.namedChild(0).type),
  );
  if (callStatement) {
    const { lineStart } = lineIndent(source, callStatement.startIndex);
    let end = source.indexOf('\n', callStatement.endIndex);
    end = end === -1 ? source.length : end + 1;
    add('delete_call', false, [{ start: lineStart, end, replacement: '' }]);
  }

  return out;
}

function applyEdits(source, edits) {
  const ordered = [...edits].sort((x, y) => y.start - x.start);
  let out = source;
  for (const e of ordered) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

/**
 * All labeled mutations for a file.
 * Returns [{ symbol, kind, semanticPreserving, mutated }].
 */
export function generateMutations(source, language) {
  const tree = parse(source, language);
  const symbols = collectSymbols(source, language);
  const byName = new Map(symbols.map((s) => [s.name, s]));
  const cases = [];

  for (const node of walk(tree.rootNode)) {
    if (!FUNCTION_TYPES.has(node.type)) continue;
    const name = functionName(node);
    if (!name || !byName.has(name)) continue;
    for (const m of mutationsFor(source, language, node)) {
      const mutated = applyEdits(source, m.edits);
      if (mutated === source) continue;
      // A mutation that changes the set of symbols invalidates the premise that
      // we can match symbols by name before and after.
      let after;
      try {
        after = collectSymbols(mutated, language);
      } catch {
        continue;
      }
      if (!after.some((s) => s.name === name)) continue;
      cases.push({ symbol: name, kind: m.kind, semanticPreserving: m.semanticPreserving, mutated });
    }
  }
  tree.delete();
  return cases;
}
