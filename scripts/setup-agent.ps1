<#
.SYNOPSIS
  Bootstrap cgraph + enable Copilot agent workflow for a workspace.

.DESCRIPTION
  - Installs dependencies (optional) and builds cgraph
  - Configures `.vscode/mcp.json` to run local cgraph MCP server
  - Enables workspace Copilot settings for agent workflow
    - Verifies repo-scoped agent files for dropdown mode (cgraph auto)

.EXAMPLE
  .\scripts\setup-agent.ps1
  .\scripts\setup-agent.ps1 -ProjectPath . -SkipInstall
#>
param(
    [string]$ProjectPath = ".",
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$m) Write-Host "`n=> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "   $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "   $m" -ForegroundColor Yellow }

$resolvedProject = (Resolve-Path $ProjectPath).Path
$repoRoot = Split-Path $PSScriptRoot

$agentFile = Join-Path $repoRoot ".github\agents\cgraph-auto.agent.md"
$instructionsFile = Join-Path $repoRoot ".github\copilot-instructions.md"
$setupMcpScript = Join-Path $repoRoot "scripts\setup-mcp.ps1"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  cgraph Agent Bootstrap" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Repo:    $repoRoot"
Write-Host "  Project: $resolvedProject"
Write-Host ""

Write-Step "Checking prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
$npm  = Get-Command npm  -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw "Node.js/npm not found. Install Node.js >= 18 and re-run."
}
$nodeVer = & node --version
Write-Ok "Node detected: $nodeVer"

if (-not $SkipInstall) {
    Write-Step "Installing dependencies"
    Push-Location $repoRoot
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Step "Building project"
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    Pop-Location
    Write-Ok "Build complete"
} else {
    Write-Warn "SkipInstall enabled - skipping npm install/build"
}

Write-Step "Configuring MCP for workspace"
if (-not (Test-Path $setupMcpScript)) {
    throw "Missing script: $setupMcpScript"
}
& powershell -ExecutionPolicy Bypass -File $setupMcpScript $resolvedProject -Force
if ($LASTEXITCODE -ne 0) { throw "setup-mcp.ps1 failed" }
Write-Ok "MCP configured"

Write-Step "Enabling workspace Copilot agent settings"
$vscodeDir = Join-Path $resolvedProject ".vscode"
$settingsFile = Join-Path $vscodeDir "settings.json"
if (-not (Test-Path $vscodeDir)) {
    New-Item -ItemType Directory -Path $vscodeDir -Force | Out-Null
}

$settings = @{}
if (Test-Path $settingsFile) {
    try {
        $raw = Get-Content $settingsFile -Raw -Encoding UTF8
        if ($raw.Trim()) { $settings = $raw | ConvertFrom-Json -AsHashtable }
    } catch {
        Write-Warn "Existing settings.json is not valid JSON; replacing with minimal valid settings"
        $settings = @{}
    }
}

$settings["github.copilot.chat.claudeAgent.allowAutoPermissions"] = $true
$settings["github.copilot.chat.agent.autoFix"] = $true

$settings | ConvertTo-Json -Depth 12 | Set-Content -Path $settingsFile -Encoding UTF8
Write-Ok "Updated $settingsFile"

Write-Step "Validating custom dropdown agent files"
if (Test-Path $agentFile) {
    Write-Ok "Found: .github/agents/cgraph-auto.agent.md"
} else {
    Write-Warn "Missing: .github/agents/cgraph-auto.agent.md"
}

if (Test-Path $instructionsFile) {
    Write-Ok "Found: .github/copilot-instructions.md"
} else {
    Write-Warn "Missing: .github/copilot-instructions.md"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1) Reload VS Code window"
Write-Host "  2) In Copilot Chat, open the agent dropdown"
Write-Host "  3) Select: cgraph auto"
Write-Host ""
