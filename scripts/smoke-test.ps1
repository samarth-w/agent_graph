<# .SYNOPSIS
  Smoke-test all cgraph CLI commands against a temp project.
  Inspired by codegraph's agent-eval probes.
.EXAMPLE
  .\scripts\smoke-test.ps1
  .\scripts\smoke-test.ps1 -Verbose
#>
param([switch]$Verbose)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$cgraph = Join-Path $root "bin\cgraph.js"
$passed = 0
$failed = 0
$errors = @()

function Run-Cgraph {
    param([string[]]$CgArgs)
    $result = & node $cgraph @CgArgs 2>&1 | Out-String
    return $result
}

function Run-Test {
    param([string]$Name, [string[]]$CgArgs, [string]$Expect)

    try {
        $output = Run-Cgraph -CgArgs $CgArgs
        if ($Expect -and $output -notmatch [regex]::Escape($Expect)) {
            throw "Expected pattern '$Expect' not found in output"
        }
        $script:passed++
        Write-Host "  PASS  $Name" -ForegroundColor Green
        if ($Verbose) { Write-Host $output -ForegroundColor DarkGray }
    }
    catch {
        $script:failed++
        $script:errors += "$Name : $_"
        Write-Host "  FAIL  $Name : $_" -ForegroundColor Red
    }
}

# --- Setup: create temp project with sample files ---
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "cgraph-smoke-$(Get-Random)"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

# TypeScript files
@"
export function greet(name: string): string {
  return formatMessage("Hello", name);
}

function formatMessage(prefix: string, name: string): string {
  return prefix + " " + name;
}

export class UserService {
  getUser(id: number) { return this.findById(id); }
  private findById(id: number) { return { id }; }
}
"@ | Set-Content (Join-Path $tmpDir "app.ts")

@"
import { greet, UserService } from './app';

export function main() {
  const msg = greet("world");
  console.log(msg);
  const svc = new UserService();
  const user = svc.getUser(1);
  return user;
}

export function healthCheck() {
  return { status: "ok" };
}
"@ | Set-Content (Join-Path $tmpDir "index.ts")

# Python file
@"
from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify(status="ok")

@app.get('/users')
def list_users():
    return jsonify(get_all_users())

def get_all_users():
    return [{"id": 1, "name": "Alice"}]

class DataStore:
    def connect(self):
        pass
    def query(self, sql):
        return self.connect()
"@ | Set-Content (Join-Path $tmpDir "server.py")

Push-Location $tmpDir

try {
    Write-Host ""
    Write-Host "cgraph Smoke Test" -ForegroundColor Cyan
    Write-Host "=================" -ForegroundColor Cyan
    Write-Host "Temp project: $tmpDir"
    Write-Host ""

    # --- 1. Index ---
    Write-Host "--- Indexing ---" -ForegroundColor Yellow
    Run-Test "index" -CgArgs @("index") -Expect '"files_scanned":3'

    # --- 2. Status ---
    Write-Host "--- Status ---" -ForegroundColor Yellow
    Run-Test "status" -CgArgs @("status") -Expect '"files_count":3'

    # --- 3. Files ---
    Write-Host "--- Files ---" -ForegroundColor Yellow
    Run-Test "files" -CgArgs @("files") -Expect '"total":3'

    # --- 4. Search ---
    Write-Host "--- Search ---" -ForegroundColor Yellow
    Run-Test "search greet" -CgArgs @("search", "greet") -Expect '"name":"greet"'
    Run-Test "search kind:class" -CgArgs @("search", "Service", "--kind", "class") -Expect '"kind":"class"'
    Run-Test "search kind:route" -CgArgs @("search", "route", "--kind", "route") -Expect '"kind":"route"'

    # --- 5. Callers ---
    Write-Host "--- Callers ---" -ForegroundColor Yellow
    Run-Test "callers formatMessage" -CgArgs @("callers", "formatMessage") -Expect '"name":"greet"'

    # --- 6. Callees ---
    Write-Host "--- Callees ---" -ForegroundColor Yellow
    Run-Test "callees greet" -CgArgs @("callees", "greet") -Expect '"name":"formatMessage"'
    Run-Test "callees main" -CgArgs @("callees", "main") -Expect '"name":"greet"'

    # --- 7. Impact ---
    Write-Host "--- Impact ---" -ForegroundColor Yellow
    Run-Test "impact formatMessage" -CgArgs @("impact", "formatMessage") -Expect 'impacted'

    # --- 8. Trace ---
    Write-Host "--- Trace ---" -ForegroundColor Yellow
    Run-Test "trace main->formatMessage" -CgArgs @("trace", "main", "formatMessage") -Expect '"found":true'
    Run-Test "trace no-path" -CgArgs @("trace", "healthCheck", "formatMessage") -Expect '"found":false'

    # --- 9. Node ---
    Write-Host "--- Node ---" -ForegroundColor Yellow
    Run-Test "node greet" -CgArgs @("node", "greet") -Expect '"trail"'
    Run-Test "node UserService" -CgArgs @("node", "UserService") -Expect '"kind":"class"'

    # --- 10. Explore ---
    Write-Host "--- Explore ---" -ForegroundColor Yellow
    Run-Test "explore greet" -CgArgs @("explore", "greet") -Expect '"source"'

    # --- 11. Context ---
    Write-Host "--- Context ---" -ForegroundColor Yellow
    Run-Test "context task" -CgArgs @("context", "how does greeting work") -Expect '"estimated_tokens"'

    # --- 12. Sync (no changes) ---
    Write-Host "--- Sync ---" -ForegroundColor Yellow
    Run-Test "sync no-op" -CgArgs @("sync") -Expect '"files_changed":0'

    # --- 13. Python-specific ---
    Write-Host "--- Python ---" -ForegroundColor Yellow
    Run-Test "search Flask route" -CgArgs @("search", "health", "--kind", "route") -Expect '"route"'
    Run-Test "python class" -CgArgs @("search", "DataStore", "--kind", "class") -Expect '"DataStore"'

    # --- 14. Agentic Intelligence ---
    Write-Host "--- Agentic Intelligence ---" -ForegroundColor Yellow
    Run-Test "auto-context" -CgArgs @("auto-context", "app.ts") -Expect '"symbols"'
    Run-Test "intent search" -CgArgs @("intent", "greet user") -Expect '"results"'
    Run-Test "dna" -CgArgs @("dna") -Expect '"languages"'

    # --- Summary ---
    Write-Host ""
    Write-Host "==================" -ForegroundColor Cyan
    Write-Host "Passed: $passed" -ForegroundColor Green
    if ($failed -gt 0) {
        Write-Host "Failed: $failed" -ForegroundColor Red
        foreach ($e in $errors) {
            Write-Host "  - $e" -ForegroundColor Red
        }
        exit 1
    }
    else {
        Write-Host "Failed: 0" -ForegroundColor Green
        Write-Host "All smoke tests passed!" -ForegroundColor Green
    }
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
