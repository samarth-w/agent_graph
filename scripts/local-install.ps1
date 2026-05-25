<# .SYNOPSIS
  Build + link cgraph globally for local testing (Windows).
.EXAMPLE
  .\scripts\local-install.ps1          # build + link
  .\scripts\local-install.ps1 -Undo    # unlink
#>
param([switch]$Undo)

$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot)

try {
    $pkg = (Get-Content package.json | ConvertFrom-Json).name
    $ver = (Get-Content package.json | ConvertFrom-Json).version

    if ($Undo) {
        Write-Host "-> unlinking $pkg"
        npm unlink -g $pkg 2>$null
        Write-Host "done: cgraph unlinked"
        return
    }

    $branch = git rev-parse --abbrev-ref HEAD 2>$null
    if (-not $branch) { $branch = "detached" }

    Write-Host "-> building $pkg $ver ($branch)"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }

    Write-Host "-> linking globally"
    npm link
    if ($LASTEXITCODE -ne 0) { throw "Link failed" }

    $linked = (Get-Command cgraph -ErrorAction SilentlyContinue).Source
    if (-not $linked) { $linked = "(not on PATH)" }

    Write-Host ""
    Write-Host "global cgraph now points to this branch" -ForegroundColor Green
    Write-Host "  binary:  $linked"
    Write-Host "  branch:  $branch"
    Write-Host "  version: $ver"
    Write-Host ""
    Write-Host "To undo: .\scripts\local-install.ps1 -Undo"
}
finally {
    Pop-Location
}
