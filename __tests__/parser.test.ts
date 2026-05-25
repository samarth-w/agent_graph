/**
 * Parser Tests — extraction of symbols, calls, and imports from source code.
 */
import { describe, it, expect } from 'vitest';
import { parseFile } from '../src/parser';

describe('Language Detection & Dispatch', () => {
  it('should return empty result for unsupported language', () => {
    const result = parseFile('fn main() {}', 'rust', 'main.rs');
    expect(result.symbols).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.imports).toEqual([]);
  });
});

describe('TypeScript Extraction', () => {
  it('should extract function declarations', () => {
    const code = `export function greet(name: string): string {
  return "Hello " + name;
}`;
    const result = parseFile(code, 'typescript', 'greet.ts');
    const fn = result.symbols.find(s => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.exported).toBe(true);
  });

  it('should extract class declarations', () => {
    const code = `export class UserService {
  private db: Database;
  constructor(db: Database) { this.db = db; }
  findUser(id: string) { return this.db.find(id); }
}`;
    const result = parseFile(code, 'typescript', 'user.ts');
    const cls = result.symbols.find(s => s.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.exported).toBe(true);

    const method = result.symbols.find(s => s.name === 'findUser');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('should extract arrow function exports', () => {
    const code = `export const useAuth = (): AuthContextValue => {
  return useContext(AuthContext);
};`;
    const result = parseFile(code, 'typescript', 'hooks.ts');
    const fn = result.symbols.find(s => s.name === 'useAuth');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.exported).toBe(true);
  });

  it('should not extract non-exported arrow functions as exported', () => {
    const code = `const internalHelper = () => { return 42; };`;
    const result = parseFile(code, 'typescript', 'internal.ts');
    const fn = result.symbols.find(s => s.name === 'internalHelper');
    expect(fn).toBeDefined();
    expect(fn!.exported).toBeFalsy();
  });

  it('should extract interfaces', () => {
    const code = `export interface PaymentResult {
  success: boolean;
  transactionId: string;
}`;
    const result = parseFile(code, 'typescript', 'types.ts');
    const iface = result.symbols.find(s => s.name === 'PaymentResult');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('should extract type aliases', () => {
    const code = `export type UserId = string;`;
    const result = parseFile(code, 'typescript', 'types.ts');
    const ta = result.symbols.find(s => s.name === 'UserId');
    expect(ta).toBeDefined();
    expect(ta!.kind).toBe('type_alias');
  });

  it('should extract enums', () => {
    const code = `export enum Status { Active, Inactive }`;
    const result = parseFile(code, 'typescript', 'types.ts');
    const en = result.symbols.find(s => s.name === 'Status');
    expect(en).toBeDefined();
    expect(en!.kind).toBe('enum');
  });

  it('should extract imports', () => {
    const code = `import { GraphDB } from './storage';
import path from 'path';
import type { Node } from './types';`;
    const result = parseFile(code, 'typescript', 'index.ts');
    expect(result.imports.length).toBeGreaterThanOrEqual(3);
    const storageImport = result.imports.find(i => i.source === './storage');
    expect(storageImport).toBeDefined();
    expect(storageImport!.specifiers.some(s => s.name === 'GraphDB')).toBe(true);
  });

  it('should extract calls with enclosing symbol', () => {
    const code = `function processData(input: string) {
  const cleaned = sanitize(input);
  const result = transform(cleaned);
  return result;
}`;
    const result = parseFile(code, 'typescript', 'process.ts');
    const sanitizeCall = result.calls.find(c => c.callee === 'sanitize');
    expect(sanitizeCall).toBeDefined();
    expect(sanitizeCall!.enclosingSymbol).toContain('processData');

    const transformCall = result.calls.find(c => c.callee === 'transform');
    expect(transformCall).toBeDefined();
  });

  it('should extract method calls with receiver', () => {
    const code = `function run(db: Database) {
  db.query('SELECT 1');
  db.close();
}`;
    const result = parseFile(code, 'typescript', 'run.ts');
    const queryCall = result.calls.find(c => c.callee === 'query');
    expect(queryCall).toBeDefined();
    expect(queryCall!.receiver).toBe('db');
  });

  it('should extract calls inside variable initializers', () => {
    const code = `function main() {
  const result = parseFile(content, language, path);
  return result;
}`;
    const result = parseFile(code, 'typescript', 'main.ts');
    const pfCall = result.calls.find(c => c.callee === 'parseFile');
    expect(pfCall).toBeDefined();
    expect(pfCall!.enclosingSymbol).toContain('main');
  });

  it('should extract class with extends', () => {
    const code = `class AdminService extends BaseService {
  getAdmins() { return []; }
}`;
    const result = parseFile(code, 'typescript', 'admin.ts');
    const cls = result.symbols.find(s => s.name === 'AdminService');
    expect(cls).toBeDefined();
    expect(cls!.extends).toBe('BaseService');
  });

  it('should handle JSX files', () => {
    const code = `export function App() {
  return <div><Header /><Main /></div>;
}`;
    const result = parseFile(code, 'jsx', 'App.jsx');
    const fn = result.symbols.find(s => s.name === 'App');
    expect(fn).toBeDefined();
  });

  it('should handle TSX files', () => {
    const code = `export const Button: React.FC<Props> = ({ label }) => {
  return <button>{label}</button>;
};`;
    const result = parseFile(code, 'tsx', 'Button.tsx');
    const fn = result.symbols.find(s => s.name === 'Button');
    expect(fn).toBeDefined();
  });

  it('should handle syntax errors gracefully', () => {
    const code = `function broken( { return }`;
    const result = parseFile(code, 'typescript', 'broken.ts');
    // Should not throw, returns partial results
    expect(result).toBeDefined();
  });
});

describe('Python Extraction', () => {
  it('should extract function definitions', () => {
    const code = `def calculate_total(items, tax_rate):
    """Calculate total with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax_rate)`;
    const result = parseFile(code, 'python', 'calc.py');
    const fn = result.symbols.find(s => s.name === 'calculate_total');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('should extract class definitions', () => {
    const code = `class UserRepository:
    def __init__(self, db):
        self.db = db

    def find_by_id(self, user_id):
        return self.db.query(user_id)`;
    const result = parseFile(code, 'python', 'repo.py');
    const cls = result.symbols.find(s => s.name === 'UserRepository');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');

    const method = result.symbols.find(s => s.name === 'find_by_id');
    expect(method).toBeDefined();
  });

  it('should extract imports', () => {
    const code = `import os
from pathlib import Path
from typing import List, Optional`;
    const result = parseFile(code, 'python', 'utils.py');
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it('should extract decorated functions', () => {
    const code = `@app.route('/users')
def list_users():
    return []`;
    const result = parseFile(code, 'python', 'routes.py');
    const fn = result.symbols.find(s => s.name === 'list_users');
    expect(fn).toBeDefined();
  });
});
