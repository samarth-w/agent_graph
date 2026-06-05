/**
 * Deep edge-case tests for parseFile.
 * Covers: JS/TS/JSX/TSX via @babel/parser, Python regex extractor, C/C++ regex extractor.
 */
import { describe, it, expect } from 'vitest';
import { parseFile } from '../src/parser';

// ─── helpers ────────────────────────────────────────────────────
function names(r: ReturnType<typeof parseFile>) { return r.symbols.map(s => s.name); }
function kinds(r: ReturnType<typeof parseFile>) { return r.symbols.map(s => s.kind); }
function callees(r: ReturnType<typeof parseFile>) { return r.calls.map(c => c.callee); }
function importSources(r: ReturnType<typeof parseFile>) { return r.imports.map(i => i.source); }

// ════════════════════════════════════════════════════════════════
//  JS / TS
// ════════════════════════════════════════════════════════════════
describe('parseFile — TypeScript', () => {

  it('returns empty result for empty string', () => {
    const r = parseFile('', 'typescript', 'x.ts');
    expect(r.symbols).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
    expect(r.imports).toHaveLength(0);
  });

  it('recovers gracefully from invalid syntax', () => {
    const r = parseFile('this is not {{{ valid JS ]]]', 'typescript', 'bad.ts');
    // Must not throw; may return empty or partial
    expect(Array.isArray(r.symbols)).toBe(true);
  });

  it('extracts exported function declaration', () => {
    const r = parseFile('export function greet(name: string): string { return `Hello ${name}`; }', 'typescript', 'a.ts');
    expect(names(r)).toContain('greet');
    const sym = r.symbols.find(s => s.name === 'greet')!;
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(true);
  });

  it('marks non-exported function as unexported', () => {
    const r = parseFile('function helper() {}', 'typescript', 'a.ts');
    const sym = r.symbols.find(s => s.name === 'helper')!;
    expect(sym.exported).toBe(false);
  });

  it('extracts class declaration with superclass', () => {
    const r = parseFile('export class Dog extends Animal {}', 'typescript', 'a.ts');
    const sym = r.symbols.find(s => s.name === 'Dog')!;
    expect(sym.kind).toBe('class');
    expect(sym.extends).toBe('Animal');
    expect(sym.exported).toBe(true);
  });

  it('extracts class methods', () => {
    const r = parseFile(`
class Calc {
  add(a: number, b: number) { return a + b; }
  subtract(a: number, b: number) { return a - b; }
}`, 'typescript', 'a.ts');
    const methodNames = r.symbols.filter(s => s.kind === 'method').map(s => s.name);
    expect(methodNames).toContain('add');
    expect(methodNames).toContain('subtract');
  });

  it('extracts arrow function assigned to const', () => {
    const r = parseFile('export const double = (n: number) => n * 2;', 'typescript', 'a.ts');
    expect(names(r)).toContain('double');
  });

  it('extracts async function', () => {
    const r = parseFile('export async function fetchData() { return await fetch("/api"); }', 'typescript', 'a.ts');
    const sym = r.symbols.find(s => s.name === 'fetchData')!;
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(true);
  });

  it('tracks nested scope in qualified name', () => {
    const r = parseFile(`
function outer() {
  function inner() {}
}`, 'typescript', 'mod.ts');
    const inner = r.symbols.find(s => s.name === 'inner');
    expect(inner?.qualifiedName).toMatch(/outer/);
  });

  it('extracts function calls', () => {
    const r = parseFile('function f() { console.log("hi"); doWork(); }', 'typescript', 'a.ts');
    expect(callees(r)).toContain('doWork');
  });

  it('extracts named import', () => {
    const r = parseFile("import { readFile } from 'fs';", 'typescript', 'a.ts');
    expect(importSources(r)).toContain('fs');
    const imp = r.imports[0];
    expect(imp.specifiers.some(s => s.name === 'readFile')).toBe(true);
  });

  it('extracts default import', () => {
    const r = parseFile("import path from 'path';", 'typescript', 'a.ts');
    expect(importSources(r)).toContain('path');
    const imp = r.imports[0];
    expect(imp.specifiers.some(s => s.isDefault)).toBe(true);
  });

  it('extracts namespace import', () => {
    const r = parseFile("import * as fs from 'fs';", 'typescript', 'a.ts');
    const imp = r.imports[0];
    expect(imp.specifiers.some(s => s.isNamespace)).toBe(true);
  });

  it('does not crash on dynamic import() expression', () => {
    // import() is a CallExpression, not an ImportDeclaration — parser should not throw
    const r = parseFile("async function f() { const m = await import('./mod'); }", 'typescript', 'a.ts');
    expect(Array.isArray(r.symbols)).toBe(true);
    // the enclosing function should still be extracted
    expect(r.symbols.some(s => s.name === 'f')).toBe(true);
  });

  it('extracts TypeScript interface', () => {
    const r = parseFile('export interface User { id: number; name: string; }', 'typescript', 'a.ts');
    expect(names(r)).toContain('User');
    const sym = r.symbols.find(s => s.name === 'User')!;
    expect(sym.kind).toBe('interface');
  });

  it('extracts TypeScript enum', () => {
    const r = parseFile('export enum Direction { Up, Down, Left, Right }', 'typescript', 'a.ts');
    expect(names(r)).toContain('Direction');
  });

  it('extracts TypeScript type alias', () => {
    const r = parseFile('export type ID = string | number;', 'typescript', 'a.ts');
    expect(names(r)).toContain('ID');
  });

  it('extracts class with TypeScript decorator', () => {
    const r = parseFile(`
@Injectable()
export class UserService {}
`, 'typescript', 'a.ts');
    expect(names(r)).toContain('UserService');
  });

  it('handles multiple exports in one file', () => {
    const r = parseFile(`
export function a() {}
export function b() {}
export class C {}
export const d = 1;
`, 'typescript', 'a.ts');
    const exported = r.symbols.filter(s => s.exported);
    expect(exported.length).toBeGreaterThanOrEqual(3);
  });

  it('extracts start and end line numbers', () => {
    const r = parseFile(`
function single() {
  return 1;
}
`, 'typescript', 'a.ts');
    const sym = r.symbols.find(s => s.name === 'single')!;
    expect(sym.startLine).toBeGreaterThanOrEqual(1);
    expect(sym.endLine).toBeGreaterThanOrEqual(sym.startLine);
  });

  it('returns empty result for whitespace-only content', () => {
    const r = parseFile('   \n\t  \n   ', 'typescript', 'a.ts');
    expect(r.symbols).toHaveLength(0);
  });

  it('handles JSX in tsx file', () => {
    const r = parseFile(`
export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
`, 'tsx', 'Button.tsx');
    expect(names(r)).toContain('Button');
  });

  it('returns empty result for unknown language', () => {
    const r = parseFile('some content', 'ruby', 'a.rb');
    expect(r.symbols).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
    expect(r.imports).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  Python
// ════════════════════════════════════════════════════════════════
describe('parseFile — Python', () => {

  it('returns empty for empty string', () => {
    const r = parseFile('', 'python', 'a.py');
    expect(r.symbols).toHaveLength(0);
  });

  it('extracts top-level function', () => {
    const r = parseFile('def greet(name):\n    return f"Hello {name}"', 'python', 'a.py');
    expect(names(r)).toContain('greet');
    const sym = r.symbols.find(s => s.name === 'greet')!;
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(true); // top-level, not _-prefixed
  });

  it('marks private function as not exported', () => {
    const r = parseFile('def _helper():\n    pass', 'python', 'a.py');
    const sym = r.symbols.find(s => s.name === '_helper')!;
    expect(sym.exported).toBe(false);
  });

  it('extracts class with methods', () => {
    const r = parseFile(`
class Dog:
    def bark(self):
        print("Woof")
    def fetch(self, item):
        return item
`, 'python', 'a.py');
    const cls = r.symbols.find(s => s.kind === 'class')!;
    expect(cls.name).toBe('Dog');
    const methods = r.symbols.filter(s => s.kind === 'method');
    expect(methods.map(m => m.name)).toContain('bark');
    expect(methods.map(m => m.name)).toContain('fetch');
  });

  it('method qualified name includes class prefix', () => {
    const r = parseFile(`
class Animal:
    def speak(self):
        pass
`, 'python', 'a.py');
    const speak = r.symbols.find(s => s.name === 'speak')!;
    expect(speak.qualifiedName).toMatch(/Animal/);
  });

  it('extracts class with base class', () => {
    const r = parseFile('class Labrador(Dog):\n    pass', 'python', 'a.py');
    const sym = r.symbols.find(s => s.name === 'Labrador')!;
    expect(sym.extends).toBe('Dog');
  });

  it('extracts docstring for function', () => {
    const r = parseFile(`
def add(a, b):
    """Add two numbers."""
    return a + b
`, 'python', 'a.py');
    const sym = r.symbols.find(s => s.name === 'add')!;
    expect(sym.doc).toContain('Add two numbers');
  });

  it('extracts from-import with alias', () => {
    const r = parseFile('from os.path import join as path_join', 'python', 'a.py');
    const imp = r.imports[0];
    expect(imp.source).toBe('os.path');
    const spec = imp.specifiers.find(s => s.name === 'join');
    expect(spec?.alias).toBe('path_join');
  });

  it('extracts plain import', () => {
    const r = parseFile('import os\nimport sys', 'python', 'a.py');
    expect(importSources(r)).toContain('os');
    expect(importSources(r)).toContain('sys');
  });

  it('extracts function calls inside function body', () => {
    const r = parseFile(`
def process():
    connect()
    run()
`, 'python', 'a.py');
    expect(callees(r)).toContain('connect');
    expect(callees(r)).toContain('run');
  });

  it('skips Python keywords as calls', () => {
    const r = parseFile(`
def f():
    if True:
        return(1)
`, 'python', 'a.py');
    expect(callees(r)).not.toContain('if');
    expect(callees(r)).not.toContain('return');
  });

  it('handles deeply nested classes', () => {
    const r = parseFile(`
class Outer:
    class Inner:
        def method(self):
            pass
`, 'python', 'a.py');
    const method = r.symbols.find(s => s.name === 'method')!;
    expect(method.qualifiedName).toMatch(/Outer/);
    expect(method.qualifiedName).toMatch(/Inner/);
  });

  it('handles comment-only file', () => {
    const r = parseFile('# just a comment\n# another line', 'python', 'a.py');
    expect(r.symbols).toHaveLength(0);
  });

  it('extracts __init__ method', () => {
    const r = parseFile(`
class Foo:
    def __init__(self, x):
        self.x = x
`, 'python', 'a.py');
    expect(names(r)).toContain('__init__');
  });
});

// ════════════════════════════════════════════════════════════════
//  C / C++
// ════════════════════════════════════════════════════════════════
describe('parseFile — C/C++', () => {

  it('returns empty for empty string', () => {
    const r = parseFile('', 'c', 'a.c');
    expect(r.symbols).toHaveLength(0);
  });

  it('extracts #include as import', () => {
    const r = parseFile('#include <stdio.h>\n#include "myheader.h"', 'c', 'a.c');
    expect(importSources(r)).toContain('stdio.h');
    expect(importSources(r)).toContain('myheader.h');
  });

  it('extracts namespace', () => {
    const r = parseFile('namespace MyApp {\nint x = 0;\n}', 'cpp', 'a.cpp');
    expect(names(r)).toContain('MyApp');
  });

  it('extracts struct', () => {
    const r = parseFile('struct Point { int x; int y; };', 'c', 'a.c');
    expect(names(r)).toContain('Point');
    const sym = r.symbols.find(s => s.name === 'Point')!;
    expect(sym.kind).toBe('struct');
  });

  it('extracts enum', () => {
    const r = parseFile('enum Color { RED, GREEN, BLUE };', 'c', 'a.c');
    expect(names(r)).toContain('Color');
  });

  it('extracts class (C++)', () => {
    const r = parseFile('class Animal {\npublic:\n  void speak();\n};', 'cpp', 'a.cpp');
    expect(names(r)).toContain('Animal');
    const sym = r.symbols.find(s => s.name === 'Animal')!;
    expect(sym.kind).toBe('class');
  });

  it('extracts class with base class (C++)', () => {
    const r = parseFile('class Dog : public Animal {\n};', 'cpp', 'a.cpp');
    const sym = r.symbols.find(s => s.name === 'Dog')!;
    expect(sym.extends).toBe('Animal');
  });

  it('extracts function definition', () => {
    const r = parseFile('int add(int a, int b) {\n  return a + b;\n}', 'c', 'a.c');
    expect(names(r)).toContain('add');
    const sym = r.symbols.find(s => s.name === 'add')!;
    expect(sym.kind).toBe('function');
  });

  it('extracts function calls', () => {
    const r = parseFile('void run() {\n  init();\n  process();\n}', 'c', 'a.c');
    expect(callees(r)).toContain('init');
    expect(callees(r)).toContain('process');
  });

  it('skips C keywords as function calls', () => {
    const r = parseFile('void f() {\n  if (true) return;\n  for (;;) break;\n}', 'c', 'a.c');
    expect(callees(r)).not.toContain('if');
    expect(callees(r)).not.toContain('for');
    expect(callees(r)).not.toContain('return');
  });

  it('strips block comments before matching', () => {
    const r = parseFile('/* struct Fake { }; */ int real(int x) {\n  return x;\n}', 'c', 'a.c');
    expect(names(r)).not.toContain('Fake');
    expect(names(r)).toContain('real');
  });

  it('handles empty function body', () => {
    const r = parseFile('void noop() {}', 'c', 'a.c');
    expect(names(r)).toContain('noop');
  });
});
