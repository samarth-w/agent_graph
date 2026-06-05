<# .SYNOPSIS
  Set up cgraph MCP server config in a target project's .vscode/mcp.json.
.EXAMPLE
  .\scripts\setup-mcp.ps1 C:\Projects\my-app
  .\scripts\setup-mcp.ps1 .                     # current dir
#>
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$ProjectPath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ProjectPath = Resolve-Path $ProjectPath
$cgraphRoot = Split-Path $PSScriptRoot
$cgraphBin = Join-Path $cgraphRoot "bin\cgraph.js"
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) { $nodePath = "node" }

$vscodeDir = Join-Path $ProjectPath ".vscode"
$mcpFile = Join-Path $vscodeDir "mcp.json"

# Build the config
$config = @{
    servers = @{
        cgraph = @{
            command = $nodePath
            args = @($cgraphBin, "serve", "--mcp")
            cwd = '${workspaceFolder}'
        }
    }
}

# Check if file exists
if (Test-Path $mcpFile) {
    $existing = Get-Content $mcpFile -Raw | ConvertFrom-Json
    if ($existing.servers.cgraph) {
        Write-Host "cgraph already configured in $mcpFile" -ForegroundColor Yellow
        Write-Host "Current command: $($existing.servers.cgraph.command)"
        if (-not $Force) {
            $answer = Read-Host "Overwrite? (y/N)"
            if ($answer -ne 'y') {
                Write-Host "Skipped."
                exit 0
            }
        } else {
            Write-Host "Force mode enabled: overwriting existing cgraph MCP config." -ForegroundColor Yellow
        }
    }
}

# Write config
if (-not (Test-Path $vscodeDir)) {
    New-Item -ItemType Directory -Path $vscodeDir -Force | Out-Null
}

$json = $config | ConvertTo-Json -Depth 4
$json | Set-Content $mcpFile -Encoding UTF8

Write-Host ""
Write-Host "MCP config written to: $mcpFile" -ForegroundColor Green
Write-Host ""
Write-Host "Node:    $nodePath"
Write-Host "cgraph:  $cgraphBin"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open the project in VS Code"
Write-Host "  2. Run: cgraph index    (from the project directory)"
Write-Host "  3. Restart VS Code - cgraph tools appear in Copilot Chat"
