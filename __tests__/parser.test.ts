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

// ─────────────────────────────────────────────────────────────────
//  C / C++ Extraction
// ─────────────────────────────────────────────────────────────────
describe('C Extraction', () => {
  it('should extract function definitions', () => {
    const code = `int add(int a, int b) {
  return a + b;
}`;
    const result = parseFile(code, 'c', 'math.c');
    const fn = result.symbols.find(s => s.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.exported).toBe(true);
  });

  it('should extract static functions as non-exported', () => {
    const code = `static void helper(void) {
  return;
}`;
    const result = parseFile(code, 'c', 'util.c');
    const fn = result.symbols.find(s => s.name === 'helper');
    expect(fn).toBeDefined();
    expect(fn!.exported).toBe(false);
  });

  it('should extract structs', () => {
    const code = `struct Point {
  int x;
  int y;
};`;
    const result = parseFile(code, 'c', 'types.h');
    const st = result.symbols.find(s => s.name === 'Point');
    expect(st).toBeDefined();
    expect(st!.kind).toBe('struct');
  });

  it('should extract enums', () => {
    const code = `enum Color {
  RED,
  GREEN,
  BLUE
};`;
    const result = parseFile(code, 'c', 'colors.h');
    const en = result.symbols.find(s => s.name === 'Color');
    expect(en).toBeDefined();
    expect(en!.kind).toBe('enum');
  });

  it('should extract typedefs', () => {
    const code = `typedef unsigned long size_t;`;
    const result = parseFile(code, 'c', 'types.h');
    const td = result.symbols.find(s => s.name === 'size_t');
    expect(td).toBeDefined();
    expect(td!.kind).toBe('type_alias');
  });

  it('should extract #include directives', () => {
    const code = `#include <stdio.h>
#include "myheader.h"
int main() { return 0; }`;
    const result = parseFile(code, 'c', 'main.c');
    expect(result.imports.length).toBe(2);
    expect(result.imports[0].source).toBe('stdio.h');
    expect(result.imports[1].source).toBe('myheader.h');
  });

  it('should extract function calls', () => {
    const code = `void process(int* data) {
  int len = strlen(data);
  printf("len=%d\\n", len);
  free(data);
}`;
    const result = parseFile(code, 'c', 'proc.c');
    const printfCall = result.calls.find(c => c.callee === 'printf');
    expect(printfCall).toBeDefined();
    const strlenCall = result.calls.find(c => c.callee === 'strlen');
    expect(strlenCall).toBeDefined();
  });

  it('should handle doc comments', () => {
    const code = `/** Adds two numbers. */
int add(int a, int b) {
  return a + b;
}`;
    const result = parseFile(code, 'c', 'math.c');
    const fn = result.symbols.find(s => s.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain('Adds two numbers');
  });
});

describe('C++ Extraction', () => {
  it('should extract classes with inheritance', () => {
    const code = `class Animal : public Base {
public:
  virtual void speak() = 0;
};`;
    const result = parseFile(code, 'cpp', 'animal.hpp');
    const cls = result.symbols.find(s => s.name === 'Animal');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.extends).toBe('Base');
  });

  it('should extract namespaces', () => {
    const code = `namespace math {
  int add(int a, int b) { return a + b; }
}`;
    const result = parseFile(code, 'cpp', 'math.cpp');
    const ns = result.symbols.find(s => s.name === 'math');
    expect(ns).toBeDefined();
    expect(ns!.kind).toBe('namespace');
  });

  it('should extract enum class', () => {
    const code = `enum class Direction {
  North,
  South,
  East,
  West
};`;
    const result = parseFile(code, 'cpp', 'dir.hpp');
    const en = result.symbols.find(s => s.name === 'Direction');
    expect(en).toBeDefined();
    expect(en!.kind).toBe('enum');
  });
});

describe('ASL Extraction', () => {
  it('extracts method, device, scope, and name symbols', () => {
    const code = `DefinitionBlock ("", "DSDT", 2, "OEM", "TABLE", 0x00000000)
{
  Scope (\\_SB)
  {
    Device (PCI0)
    {
      Name (_HID, EisaId ("PNP0A08"))
      Method (TEST, 1, NotSerialized)
      {
        Store (Arg0, Local0)
        FOO (Local0)
      }
    }
  }
}`;

    const result = parseFile(code, 'asl', 'dsdt.asl');
    expect(result.symbols.some((s) => s.name === 'TEST' && s.kind === 'method')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'PCI0' && s.kind === 'struct')).toBe(true);
    expect(result.symbols.some((s) => s.name === '_SB' && s.kind === 'namespace')).toBe(true);
    expect(result.symbols.some((s) => s.name === '_HID' && s.kind === 'constant')).toBe(true);
  });

  it('extracts calls inside methods', () => {
    const code = `Method (MTHD, 0, NotSerialized)
{
  ABCD (One)
  Return (Zero)
}`;
    const result = parseFile(code, 'asl', 'test.asl');
    expect(result.calls.some((c) => c.callee === 'ABCD')).toBe(true);
  });
});

describe('Firmware Text Extraction (INF/DSC/DEC/FDF/VFR/HFR/UNI)', () => {
  it('extracts sections, assignments, includes and calls from INF-like files', () => {
    const code = `[Defines]
  BASE_NAME = TestPkg
!include Common.inc

[LibraryClasses]
  DebugLib|MdePkg/Library/BaseDebugLibNull/BaseDebugLibNull.inf
  FOO (BAR)`;
    const result = parseFile(code, 'inf', 'Pkg/Test.inf');

    expect(result.symbols.some((s) => s.name === 'Defines' && s.kind === 'module')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'BASE_NAME' && s.kind === 'constant')).toBe(true);
    expect(result.imports.some((i) => i.source === 'Common.inc')).toBe(true);
    expect(result.calls.some((c) => c.callee === 'FOO')).toBe(true);
  });

  it('extracts UNI string identifiers', () => {
    const code = `#string STR_MODULE_NAME #language en-US "My Module"`;
    const result = parseFile(code, 'uni', 'Pkg/Strings.uni');
    expect(result.symbols.some((s) => s.name === 'STR_MODULE_NAME')).toBe(true);
  });
});

describe('Batch Extraction', () => {
  it('extracts labels and call targets', () => {
    const code = `@echo off
call :build
goto :eof

:build
call tool.exe
exit /b 0`;
    const result = parseFile(code, 'batch', 'build.bat');
    expect(result.symbols.some((s) => s.name === 'build' && s.kind === 'function')).toBe(true);
    expect(result.calls.some((c) => c.callee === 'build')).toBe(true);
    expect(result.calls.some((c) => c.callee === 'tool.exe')).toBe(true);
  });
});

describe('NASM Extraction', () => {
  it('extracts labels, includes, and call instructions', () => {
    const code = `%include "macros.inc"
start:
  call init
init:
  ret`;
    const result = parseFile(code, 'nasm', 'boot.nasm');
    expect(result.symbols.some((s) => s.name === 'start')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'init')).toBe(true);
    expect(result.imports.some((i) => i.source === 'macros.inc')).toBe(true);
    expect(result.calls.some((c) => c.callee === 'init')).toBe(true);
  });
});

describe('YAML Extraction', () => {
  it('extracts keys and include-like references', () => {
    const code = `pipeline:
  stages:
    - build
include: common.yml`;
    const result = parseFile(code, 'yaml', 'ci.yaml');
    expect(result.symbols.some((s) => s.name === 'pipeline' && s.kind === 'property')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'stages' && s.kind === 'property')).toBe(true);
    expect(result.imports.some((i) => i.source === 'common.yml')).toBe(true);
  });
});

describe('Markdown Extraction', () => {
  it('extracts headings and links', () => {
    const code = `# Overview\n\nSee [Design](docs/design.md).\n\n## Details`;
    const result = parseFile(code, 'markdown', 'README.md');
    expect(result.symbols.some((s) => s.name === 'Overview')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'Details')).toBe(true);
    expect(result.imports.some((i) => i.source === 'docs/design.md')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
//  Shell / Bash Extraction
// ─────────────────────────────────────────────────────────────────
describe('Shell Extraction', () => {
  it('should extract function keyword form', () => {
    const code = `function deploy {
  echo "deploying..."
  rsync -av ./dist/ server:/app/
}`;
    const result = parseFile(code, 'shell', 'deploy.sh');
    const fn = result.symbols.find(s => s.name === 'deploy');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('should extract function paren form', () => {
    const code = `cleanup() {
  rm -rf /tmp/build
  echo "done"
}`;
    const result = parseFile(code, 'shell', 'clean.sh');
    const fn = result.symbols.find(s => s.name === 'cleanup');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('should extract source imports', () => {
    const code = `source ./config.sh
. /usr/lib/helpers.sh
echo "loaded"`;
    const result = parseFile(code, 'shell', 'init.sh');
    expect(result.imports.length).toBe(2);
    expect(result.imports[0].source).toBe('./config.sh');
    expect(result.imports[1].source).toBe('/usr/lib/helpers.sh');
  });

  it('should extract aliases', () => {
    const code = `alias ll="ls -la"
alias gs="git status"`;
    const result = parseFile(code, 'shell', 'aliases.sh');
    const ll = result.symbols.find(s => s.name === 'll');
    expect(ll).toBeDefined();
    expect(ll!.kind).toBe('variable');
  });

  it('should extract command calls', () => {
    const code = `function build {
  npm install
  npm run build
  docker build -t myapp .
}`;
    const result = parseFile(code, 'shell', 'build.sh');
    const npmCall = result.calls.find(c => c.callee === 'npm');
    expect(npmCall).toBeDefined();
    const dockerCall = result.calls.find(c => c.callee === 'docker');
    expect(dockerCall).toBeDefined();
  });

  it('should extract doc comments before function', () => {
    const code = `# Starts the server on the given port
# Usage: start_server 8080
start_server() {
  node server.js --port $1
}`;
    const result = parseFile(code, 'shell', 'server.sh');
    const fn = result.symbols.find(s => s.name === 'start_server');
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain('Starts the server');
  });
});

// ─────────────────────────────────────────────────────────────────
//  PowerShell Extraction
// ─────────────────────────────────────────────────────────────────
describe('PowerShell Extraction', () => {
  it('should extract function definitions', () => {
    const code = `function Get-UserInfo {
  param([string]$Name)
  Get-ADUser -Filter "Name -eq '$Name'"
}`;
    const result = parseFile(code, 'powershell', 'users.ps1');
    const fn = result.symbols.find(s => s.name === 'Get-UserInfo');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('should extract function with params in parens', () => {
    const code = `function Add-Numbers($a, $b) {
  return $a + $b
}`;
    const result = parseFile(code, 'powershell', 'math.ps1');
    const fn = result.symbols.find(s => s.name === 'Add-Numbers');
    expect(fn).toBeDefined();
  });

  it('should extract class definitions', () => {
    const code = `class Logger : BaseLogger {
  [void] Log([string]$msg) {
    Write-Host $msg
  }
}`;
    const result = parseFile(code, 'powershell', 'logger.ps1');
    const cls = result.symbols.find(s => s.name === 'Logger');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.extends).toBe('BaseLogger');
  });

  it('should extract enum definitions', () => {
    const code = `enum Severity {
  Low
  Medium
  High
  Critical
}`;
    const result = parseFile(code, 'powershell', 'types.ps1');
    const en = result.symbols.find(s => s.name === 'Severity');
    expect(en).toBeDefined();
    expect(en!.kind).toBe('enum');
  });

  it('should extract Import-Module', () => {
    const code = `Import-Module ActiveDirectory
Import-Module "Az.Compute"
using module MyModule`;
    const result = parseFile(code, 'powershell', 'setup.ps1');
    expect(result.imports.length).toBe(3);
    expect(result.imports[0].source).toBe('ActiveDirectory');
  });

  it('should extract dot-sourced scripts', () => {
    const code = `. ./helpers.ps1
. "C:\\scripts\\config.ps1"`;
    const result = parseFile(code, 'powershell', 'init.ps1');
    expect(result.imports.length).toBe(2);
    expect(result.imports[0].source).toBe('./helpers.ps1');
  });

  it('should extract cmdlet calls', () => {
    const code = `function Deploy-App {
  Get-Service -Name "MyApp"
  Stop-Service -Name "MyApp"
  Copy-Item -Path ./dist -Destination C:\\app
  Start-Service -Name "MyApp"
}`;
    const result = parseFile(code, 'powershell', 'deploy.ps1');
    const getCalls = result.calls.filter(c => c.callee === 'Get-Service');
    expect(getCalls.length).toBeGreaterThan(0);
    const stopCall = result.calls.find(c => c.callee === 'Stop-Service');
    expect(stopCall).toBeDefined();
  });

  it('should extract filter definitions', () => {
    const code = `filter Get-EvenNumbers {
  if ($_ % 2 -eq 0) { $_ }
}`;
    const result = parseFile(code, 'powershell', 'filters.ps1');
    const fn = result.symbols.find(s => s.name === 'Get-EvenNumbers');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('should handle comment-based help', () => {
    const code = `<#
.SYNOPSIS
  Gets server status
#>
function Get-Status {
  return "OK"
}`;
    const result = parseFile(code, 'powershell', 'status.ps1');
    const fn = result.symbols.find(s => s.name === 'Get-Status');
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain('Gets server status');
  });
});
