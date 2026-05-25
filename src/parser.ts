/**
 * Code parser — extracts symbols, calls, and imports from source files.
 *
 * JS/TS/JSX/TSX → @babel/parser  (pure JS, zero native deps)
 * Python        → regex-based extractor
 */
import { parse as babelParse } from '@babel/parser';
import type {
  ParseResult, ParsedSymbol, ParsedCall, ParsedImport,
  ImportSpecifier, SymbolKind,
} from './types';
import { isJSTS } from './config';

// ─── public entry ───────────────────────────────────────────────
export function parseFile(
  content: string,
  language: string,
  relPath: string,
): ParseResult {
  if (isJSTS(language)) return parseJSTS(content, language, relPath);
  if (language === 'python')  return parsePython(content, relPath);
  return { symbols: [], calls: [], imports: [] };
}

// ─────────────────────────────────────────────────────────────────
//  JS / TS / JSX / TSX  via @babel/parser
// ─────────────────────────────────────────────────────────────────
function parseJSTS(
  content: string, language: string, relPath: string,
): ParseResult {
  const plugins: any[] = [
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'optionalChaining',
    'nullishCoalescingOperator',
    'dynamicImport',
    'exportDefaultFrom',
    'exportNamespaceFrom',
    ['decorators', { decoratorsBeforeExport: true }],
  ];
  if (language === 'typescript' || language === 'tsx') plugins.push('typescript');
  if (language === 'jsx' || language === 'tsx') plugins.push('jsx');
  if (language === 'javascript') plugins.push('jsx'); // most JS files use JSX

  let ast: any;
  try {
    ast = babelParse(content, {
      sourceType: 'module',
      plugins,
      errorRecovery: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    return { symbols: [], calls: [], imports: [] };
  }

  const symbols: ParsedSymbol[] = [];
  const calls: ParsedCall[] = [];
  const imports: ParsedImport[] = [];
  const scopeStack: string[] = [];              // qualified names
  const lines = content.split('\n');

  function qname(name: string) {
    return scopeStack.length
      ? `${relPath}::${scopeStack.join('.')}.${name}`
      : `${relPath}::${name}`;
  }

  function currentScope(): string | null {
    return scopeStack.length
      ? `${relPath}::${scopeStack.join('.')}` : null;
  }

  function sigFromRange(node: any): string {
    if (!node.loc) return '';
    const startLine = node.loc.start.line - 1;
    const endLine = node.body?.loc?.start?.line
      ? node.body.loc.start.line - 1
      : startLine;
    return lines.slice(startLine, endLine + 1).join('\n').trim();
  }

  function extractDoc(node: any): string | null {
    if (node.leadingComments && node.leadingComments.length > 0) {
      const last = node.leadingComments[node.leadingComments.length - 1];
      if (last.type === 'CommentBlock') return last.value.trim();
    }
    return null;
  }

  // recursive walk with enter/exit for scope tracking
  function walk(node: any, exported: boolean): void {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      // ── declarations ────────────────────────────────────────
      case 'FunctionDeclaration': {
        const name = node.id?.name;
        if (!name) break;
        const sym = makeSym(name, 'function', node, exported);
        symbols.push(sym);
        scopeStack.push(name);
        walkBody(node.body, false);
        scopeStack.pop();
        return; // don't double-walk body
      }

      case 'ClassDeclaration':
      case 'ClassExpression': {
        const name = node.id?.name ?? '(anonymous)';
        const sym = makeSym(name, 'class', node, exported);
        if (node.superClass?.name) sym.extends = node.superClass.name;
        if (node.implements) {
          sym.implements = node.implements.map(
            (i: any) => i.expression?.name ?? i.id?.name ?? '',
          ).filter(Boolean);
        }
        symbols.push(sym);
        scopeStack.push(name);
        walkClassBody(node.body, false);
        scopeStack.pop();
        return;
      }

      case 'TSInterfaceDeclaration': {
        const name = node.id?.name;
        if (name) symbols.push(makeSym(name, 'interface', node, exported));
        return;
      }

      case 'TSTypeAliasDeclaration': {
        const name = node.id?.name;
        if (name) symbols.push(makeSym(name, 'type_alias', node, exported));
        return;
      }

      case 'TSEnumDeclaration': {
        const name = node.id?.name;
        if (name) symbols.push(makeSym(name, 'enum', node, exported));
        return;
      }

      case 'VariableDeclaration': {
        for (const decl of node.declarations ?? []) {
          if (!decl.id?.name) continue;
          const init = decl.init;
          if (init && (init.type === 'ArrowFunctionExpression' ||
                       init.type === 'FunctionExpression')) {
            const sym = makeSym(decl.id.name, 'function', {
              ...decl, loc: decl.loc,
              body: init.body,
            }, exported);
            symbols.push(sym);
            scopeStack.push(decl.id.name);
            walkBody(init.body, false);
            scopeStack.pop();
          } else {
            if (exported) {
              symbols.push(makeSym(decl.id.name, 'variable', decl, exported));
            }
            // Walk init expression to capture calls (e.g. const x = foo())
            if (init) walk(init, false);
          }
        }
        return;
      }

      // ── exports ─────────────────────────────────────────────
      case 'ExportNamedDeclaration': {
        if (node.declaration) walk(node.declaration, true);
        // re-exports: export { x } from './y'
        if (node.source && node.specifiers) {
          for (const spec of node.specifiers) {
            const localName = spec.exported?.name ?? spec.local?.name;
            if (localName) {
              symbols.push(makeSym(localName, 'variable', node, true));
            }
          }
        }
        return;
      }

      case 'ExportDefaultDeclaration': {
        if (node.declaration) walk(node.declaration, true);
        return;
      }

      // ── imports ─────────────────────────────────────────────
      case 'ImportDeclaration': {
        const imp: ParsedImport = {
          source: node.source?.value ?? '',
          specifiers: (node.specifiers ?? []).map((s: any): ImportSpecifier => ({
            name: s.imported?.name ?? s.local?.name ?? 'default',
            alias: s.local?.name !== (s.imported?.name ?? s.local?.name)
              ? s.local?.name : null,
            isDefault: s.type === 'ImportDefaultSpecifier',
            isNamespace: s.type === 'ImportNamespaceSpecifier',
          })),
          line: node.loc?.start?.line ?? 0,
          isDynamic: false,
        };
        imports.push(imp);
        return;
      }

      // ── calls ───────────────────────────────────────────────
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        const callee = node.callee;
        if (callee?.type === 'Identifier') {
          calls.push({
            callee: callee.name,
            line: node.loc?.start?.line ?? 0,
            enclosingSymbol: currentScope(),
          });
        } else if (callee?.type === 'MemberExpression' ||
                   callee?.type === 'OptionalMemberExpression') {
          const method = callee.property?.name ?? callee.property?.value;
          const recv   = callee.object?.name;
          if (method) {
            calls.push({
              callee: method,
              receiver: recv,
              line: node.loc?.start?.line ?? 0,
              enclosingSymbol: currentScope(),
            });
          }
        }
        break; // continue walking arguments
      }
    }

    // generic child walk
    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' ||
          key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            walk(item, false);
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        walk(child, false);
      }
    }
  }

  function walkBody(body: any, exported: boolean): void {
    if (!body) return;
    if (body.type === 'BlockStatement' && body.body) {
      for (const stmt of body.body) walk(stmt, exported);
    } else {
      walk(body, exported);
    }
  }

  function walkClassBody(body: any, exported: boolean): void {
    if (!body?.body) return;
    for (const member of body.body) {
      if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
        const name = member.key?.name ?? member.key?.id?.name ?? '(anonymous)';
        const sym = makeSym(name, 'method', member, exported);
        symbols.push(sym);
        scopeStack.push(name);
        walkBody(member.body, false);
        scopeStack.pop();
      } else if (member.type === 'ClassProperty' ||
                 member.type === 'ClassPrivateProperty') {
        const name = member.key?.name ?? member.key?.id?.name;
        if (name && member.value &&
            (member.value.type === 'ArrowFunctionExpression' ||
             member.value.type === 'FunctionExpression')) {
          const sym = makeSym(name, 'method', member, exported);
          symbols.push(sym);
          scopeStack.push(name);
          walkBody(member.value.body, false);
          scopeStack.pop();
        }
      } else {
        walk(member, false);
      }
    }
  }

  function makeSym(
    name: string, kind: SymbolKind, node: any, exported: boolean,
  ): ParsedSymbol {
    return {
      name,
      qualifiedName: qname(name),
      kind,
      startLine: node.loc?.start?.line ?? 0,
      endLine:   node.loc?.end?.line   ?? 0,
      signature: sigFromRange(node),
      doc: extractDoc(node),
      exported,
      children: [],
    };
  }

  // walk the program body
  for (const stmt of ast.program.body) {
    walk(stmt, false);
  }

  return { symbols, calls, imports };
}

// ─────────────────────────────────────────────────────────────────
//  Python — regex-based extractor
// ─────────────────────────────────────────────────────────────────
function parsePython(content: string, relPath: string): ParseResult {
  const lines = content.split('\n');
  const symbols: ParsedSymbol[] = [];
  const calls: ParsedCall[] = [];
  const imports: ParsedImport[] = [];

  // Patterns
  const reDef   = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)/;
  const reClass = /^(\s*)class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/;
  const reImport     = /^import\s+(.+)/;
  const reFromImport = /^from\s+(\S+)\s+import\s+(.+)/;
  const reCall       = /\b(\w+)\s*\(/g;

  const scopeStack: { name: string; indent: number }[] = [];

  function qname(name: string): string {
    const parts = scopeStack.map(s => s.name);
    parts.push(name);
    return `${relPath}::${parts.join('.')}`;
  }

  function currentScope(): string | null {
    if (scopeStack.length === 0) return null;
    return `${relPath}::${scopeStack.map(s => s.name).join('.')}`;
  }

  function indentLevel(line: string): number {
    const m = line.match(/^(\s*)/);
    return m ? m[1].replace(/\t/g, '    ').length : 0;
  }

  function popScope(indent: number): void {
    while (scopeStack.length > 0 &&
           scopeStack[scopeStack.length - 1].indent >= indent) {
      scopeStack.pop();
    }
  }

  // Find end of a block starting at `startIdx` with indentation > `baseIndent`
  function findBlockEnd(startIdx: number, baseIndent: number): number {
    let end = startIdx;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') { end = i; continue; }
      if (indentLevel(l) <= baseIndent) break;
      end = i;
    }
    return end;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const indent = indentLevel(line);
    const trimmed = line.trim();

    // skip empty / comments
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    popScope(indent);

    // ── class ───────────────────────────────────────────────
    const cm = line.match(reClass);
    if (cm) {
      const name = cm[2];
      const bases = cm[3]?.split(',').map(b => b.trim()).filter(Boolean);
      const endLine = findBlockEnd(i, indent) + 1;
      const sym: ParsedSymbol = {
        name,
        qualifiedName: qname(name),
        kind: 'class',
        startLine: lineNo,
        endLine,
        signature: trimmed,
        doc: extractPyDoc(lines, i),
        exported: indent === 0,
        children: [],
        extends: bases?.[0],
      };
      symbols.push(sym);
      scopeStack.push({ name, indent });
      continue;
    }

    // ── function / method ───────────────────────────────────
    const fm = line.match(reDef);
    if (fm) {
      const name = fm[2];
      const endLine = findBlockEnd(i, indent) + 1;
      const kind: SymbolKind = scopeStack.length > 0 &&
        scopeStack[scopeStack.length - 1].indent < indent
        ? 'method' : 'function';
      const sym: ParsedSymbol = {
        name,
        qualifiedName: qname(name),
        kind,
        startLine: lineNo,
        endLine,
        signature: trimmed,
        doc: extractPyDoc(lines, i),
        exported: indent === 0 && !name.startsWith('_'),
        children: [],
      };
      symbols.push(sym);
      scopeStack.push({ name, indent });
      continue;
    }

    // ── import ──────────────────────────────────────────────
    const im = trimmed.match(reFromImport);
    if (im) {
      const source = im[1];
      const names = im[2].split(',').map(n => n.trim());
      imports.push({
        source,
        specifiers: names.map(n => {
          const parts = n.split(/\s+as\s+/);
          return {
            name: parts[0],
            alias: parts[1] ?? null,
            isDefault: false,
            isNamespace: parts[0] === '*',
          };
        }),
        line: lineNo,
        isDynamic: false,
      });
      continue;
    }

    const im2 = trimmed.match(reImport);
    if (im2) {
      const modules = im2[1].split(',').map(m => m.trim());
      for (const mod of modules) {
        const parts = mod.split(/\s+as\s+/);
        imports.push({
          source: parts[0],
          specifiers: [{
            name: parts[0], alias: parts[1] ?? null,
            isDefault: true, isNamespace: false,
          }],
          line: lineNo,
          isDynamic: false,
        });
      }
      continue;
    }

    // ── calls (basic) ───────────────────────────────────────
    let cm2;
    reCall.lastIndex = 0;
    while ((cm2 = reCall.exec(trimmed)) !== null) {
      const callee = cm2[1];
      // skip keywords / builtins
      if (['if', 'for', 'while', 'with', 'print', 'return',
           'raise', 'assert', 'except', 'lambda', 'not',
           'and', 'or', 'in', 'is', 'del', 'yield'].includes(callee)) continue;
      calls.push({ callee, line: lineNo, enclosingSymbol: currentScope() });
    }
  }

  return { symbols, calls, imports };
}

function extractPyDoc(lines: string[], defLineIdx: number): string | null {
  // Check line after def/class for triple-quoted docstring
  const next = lines[defLineIdx + 1]?.trim();
  if (!next) return null;
  if (next.startsWith('"""') || next.startsWith("'''")) {
    const quote = next.slice(0, 3);
    if (next.endsWith(quote) && next.length > 6) {
      return next.slice(3, -3).trim();
    }
    // multi-line
    const docLines = [next.slice(3)];
    for (let i = defLineIdx + 2; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.includes(quote)) {
        docLines.push(l.slice(0, l.indexOf(quote)));
        return docLines.join('\n').trim();
      }
      docLines.push(l);
    }
  }
  return null;
}
