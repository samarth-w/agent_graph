<# .SYNOPSIS
  One-command installer for cgraph on Windows.
  Handles Node.js installation if missing, downloads cgraph, builds, and links.

.DESCRIPTION
  For developers who don't have Node.js or git installed.
  Downloads a portable Node.js, fetches cgraph source, builds it,
  and makes the `cgraph` command available system-wide.

.EXAMPLE
  # Run from PowerShell (no prerequisites needed):
  powershell -ExecutionPolicy Bypass -File install.ps1

  # Or with a specific install directory:
  powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\tools\cgraph"
#>
param(
    [string]$InstallDir = "$env:USERPROFILE\.cgraph-install",
    [string]$NodeVersion = "22.16.0",
    [switch]$SkipNodeInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$msg) Write-Host "`n=> $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "   $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "   $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "============================" -ForegroundColor Cyan
Write-Host "  cgraph Installer (Windows)" -ForegroundColor Cyan
Write-Host "============================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Check/Install Node.js ---
Write-Step "Checking Node.js..."

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd -and -not $SkipNodeInstall) {
    $nodeVer = & node --version 2>$null
    $major = [int]($nodeVer -replace '^v(\d+)\..*','$1')
    if ($major -ge 18) {
        Write-Ok "Found Node.js $nodeVer (OK)"
        $nodePath = $nodeCmd.Source
    } else {
        Write-Warn "Found Node.js $nodeVer but need >= 18. Will install portable Node."
        $nodeCmd = $null
    }
}

if (-not $nodeCmd) {
    Write-Step "Installing portable Node.js $NodeVersion..."

    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $nodeDir = Join-Path $InstallDir "node"
    $nodeZip = Join-Path $InstallDir "node.zip"
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$arch.zip"

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    Write-Host "   Downloading Node.js from $nodeUrl ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing

    Write-Host "   Extracting..."
    Expand-Archive -Path $nodeZip -DestinationPath $InstallDir -Force
    $extractedDir = Get-ChildItem $InstallDir -Directory | Where-Object { $_.Name -match "^node-v" } | Select-Object -First 1
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    Rename-Item $extractedDir.FullName $nodeDir
    Remove-Item $nodeZip -Force

    $nodePath = Join-Path $nodeDir "node.exe"
    $npmPath = Join-Path $nodeDir "npm.cmd"

    # Add to current session PATH
    $env:PATH = "$nodeDir;$env:PATH"
    Write-Ok "Portable Node.js installed at $nodeDir"
} else {
    $nodePath = (Get-Command node).Source
}

# Verify
$ver = & node --version 2>$null
if (-not $ver) {
    Write-Host "ERROR: Node.js not working. Please install manually from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Ok "Using Node.js $ver"

# --- 2. Get cgraph source ---
Write-Step "Setting up cgraph..."

$cgraphDir = Join-Path $InstallDir "cgraph"

# Check if git is available
$hasGit = $null -ne (Get-Command git -ErrorAction SilentlyContinue)

if (Test-Path (Join-Path $cgraphDir "package.json")) {
    Write-Ok "cgraph source already exists at $cgraphDir"
    if ($hasGit -and (Test-Path (Join-Path $cgraphDir ".git"))) {
        Write-Host "   Pulling latest..."
        Push-Location $cgraphDir
        git pull --ff-only 2>$null
        Pop-Location
    }
} elseif ($hasGit) {
    # Clone via git
    Write-Host "   Cloning cgraph repository..."
    git clone "https://github.com/samarth-w/agent_graph.git" $cgraphDir
} else {
    # Download as zip (no git required)
    Write-Host "   Downloading cgraph (no git needed)..."
    $zipUrl = "https://github.com/samarth-w/agent_graph/archive/refs/heads/master.zip"
    $zipFile = Join-Path $InstallDir "cgraph.zip"

    # Download zip from GitHub
    Write-Warn "For now, assuming cgraph source is at: $cgraphDir"

    # If running locally, copy from current directory
    $scriptDir = $PSScriptRoot
    if ($scriptDir -and (Test-Path (Join-Path $scriptDir "package.json"))) {
        Write-Host "   Copying from local source..."
        New-Item -ItemType Directory -Path $cgraphDir -Force | Out-Null
        Copy-Item -Path "$scriptDir\*" -Destination $cgraphDir -Recurse -Exclude @("node_modules", "dist", ".cgraph", ".git")
    } else {
        Write-Host "ERROR: Could not locate cgraph source. Please provide the repo URL." -ForegroundColor Red
        Write-Host "       Or copy the cgraph folder to: $cgraphDir" -ForegroundColor Red
        exit 1
    }
}

# --- 3. Install dependencies + build ---
Write-Step "Installing dependencies..."
Push-Location $cgraphDir
try {
    & npm install 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Ok "Dependencies installed"

    Write-Step "Building..."
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    Write-Ok "Build complete"

    # --- 4. Create a launcher batch file ---
    Write-Step "Creating launcher..."

    $binDir = Join-Path $InstallDir "bin"
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null

    $launcherContent = @"
@echo off
"$nodePath" "$cgraphDir\bin\cgraph.js" %*
"@
    $launcherPath = Join-Path $binDir "cgraph.cmd"
    $launcherContent | Set-Content $launcherPath -Encoding ASCII
    Write-Ok "Launcher created at $launcherPath"

    # --- 5. Add to PATH ---
    Write-Step "Configuring PATH..."

    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$binDir;$userPath", "User")
        $env:PATH = "$binDir;$env:PATH"
        Write-Ok "Added $binDir to user PATH"
        Write-Warn "Restart your terminal for PATH changes to take effect"
    } else {
        Write-Ok "$binDir already in PATH"
    }

    # --- 6. Configure VS Code user-level MCP (works in ALL workspaces) ---
    Write-Step "Configuring VS Code MCP (user-level, all workspaces)..."

    $vscodeSettingsDir = Join-Path $env:APPDATA "Code\User"
    $vscodeSettingsFile = Join-Path $vscodeSettingsDir "settings.json"

    if (Test-Path $vscodeSettingsFile) {
        $settingsRaw = Get-Content $vscodeSettingsFile -Raw -Encoding UTF8
        # Remove trailing whitespace/newlines for clean parsing
        $settingsRaw = $settingsRaw.Trim()
        if (-not $settingsRaw) { $settingsRaw = '{}' }
    } else {
        New-Item -ItemType Directory -Path $vscodeSettingsDir -Force | Out-Null
        $settingsRaw = '{}'
    }

    $nodePathEscaped = $nodePath -replace '\\', '\\\\'
    $cgraphJsEscaped = (Join-Path $cgraphDir "bin\cgraph.js") -replace '\\', '\\\\'

    if ($settingsRaw -match '"cgraph"') {
        Write-Ok "cgraph MCP already configured in VS Code settings"
    } else {
        # Build the MCP server entry
        $mcpBlock = @"
    "cgraph": {
      "command": "$nodePathEscaped",
      "args": ["$cgraphJsEscaped", "serve", "--mcp"],
      "cwd": "`${workspaceFolder}"
    }
"@

        if ($settingsRaw -match '"mcp"\s*:\s*\{\s*"servers"\s*:\s*\{') {
            # mcp.servers exists — inject cgraph into it
            $settingsRaw = $settingsRaw -replace '("mcp"\s*:\s*\{\s*"servers"\s*:\s*\{)', "`$1`n$mcpBlock,"
        } elseif ($settingsRaw -match '"mcp"\s*:\s*\{') {
            # mcp exists but no servers — add servers block
            $settingsRaw = $settingsRaw -replace '("mcp"\s*:\s*\{)', "`$1`n  `"servers`": {`n$mcpBlock`n  },"
        } else {
            # No mcp key at all — add it before the closing brace
            $mcpSection = @"

  "mcp": {
    "servers": {
$mcpBlock
    }
  }
"@
            if ($settingsRaw -eq '{}') {
                $settingsRaw = "{$mcpSection`n}"
            } else {
                $settingsRaw = $settingsRaw -replace '\}\s*$', ",$mcpSection`n}"
            }
        }

        $settingsRaw | Set-Content $vscodeSettingsFile -Encoding UTF8
        Write-Ok "Added cgraph MCP server to VS Code user settings"
        Write-Ok "cgraph is now available in ALL workspaces — no per-project setup needed"
    }

    # --- 7. Verify ---
    Write-Step "Verifying installation..."
    $testOutput = & $launcherPath --version 2>&1 | Out-String
    Write-Ok "cgraph $($testOutput.Trim()) installed successfully!"

} finally {
    Pop-Location
}

# --- Done ---
Write-Host ""
Write-Host "============================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================" -ForegroundColor Green
Write-Host ""
Write-Host "  Install dir:  $InstallDir" -ForegroundColor White
Write-Host "  Command:      cgraph" -ForegroundColor White
Write-Host "  Node:         $nodePath" -ForegroundColor White
Write-Host ""
Write-Host "  VS Code MCP:  Configured globally (user settings)" -ForegroundColor Green
Write-Host "                Works in ALL workspaces automatically" -ForegroundColor Green
Write-Host "                Auto-indexes on first Copilot query" -ForegroundColor Green
Write-Host ""
Write-Host "  That's it — open any project in VS Code and ask Copilot!" -ForegroundColor Yellow
Write-Host ""
Write-Host "  CLI also available:" -ForegroundColor Yellow
Write-Host "    cgraph index              # manual index" -ForegroundColor White
Write-Host "    cgraph status             # check what was indexed" -ForegroundColor White
Write-Host "    cgraph search myFunction  # find symbols" -ForegroundColor White
Write-Host "    cgraph callers myFunction # who calls it?" -ForegroundColor White
Write-Host ""
