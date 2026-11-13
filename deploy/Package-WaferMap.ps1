<#
.SYNOPSIS
  Build Wafer Defect Map Intelligence on this PC and package it for the VM, in the
  2D / 3D folder shape:  <repo>\dist\dist.<tag>\  (dashboard)  +  dist.<tag>\publish\api\  (API).

.DESCRIPTION
  Step A of backend/DEPLOY.md. Run it on the build PC (Node + git), then copy the
  printed dist.<tag> folder to the VM's app root and run deploy\Deploy-WaferMap.ps1 there.

    * npm install + npm run build in frontend\  ->  frontend\dist (incl. web.config, favicon)
    * <repo>\dist\dist.<tag>\              <- frontend\dist
    * <repo>\dist\dist.<tag>\publish\api\  <- backend\ minus development files
      (no tests, samples, caches, .venv, and NEVER appsettings.json - it holds the SAS token)
    * <repo>\dist\seed\152-900530D.xlsx    <- bundled layout, for a first deploy only

  <tag> is the short commit hash; "-wip" is added when the working copy has uncommitted
  changes, so the folder never claims to be a commit it is not. <repo>\dist\ is git-ignored.

.EXAMPLE
  .\deploy\Package-WaferMap.ps1
.EXAMPLE
  .\deploy\Package-WaferMap.ps1 -SkipBuild     # re-package an existing frontend\dist
#>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

if (-not $RepoRoot) { $RepoRoot = Split-Path $PSScriptRoot -Parent }
Push-Location $RepoRoot
try {
  # --- Tag ------------------------------------------------------------------
  $hash = (& git rev-parse --short HEAD).Trim()
  if ($LASTEXITCODE) { throw 'git rev-parse failed: run this inside the repository.' }
  $dirty = [bool](& git status --porcelain --untracked-files=no)
  $tag = if ($dirty) { "$hash-wip" } else { $hash }
  Info "Tag: $tag$(if ($dirty) { '  (uncommitted changes: commit first for a clean tag)' })"

  # --- Build ----------------------------------------------------------------
  if (-not $SkipBuild) {
    Info 'Building the dashboard (frontend\)'
    Push-Location frontend
    try {
      # 'npm install' (not 'npm ci'), as in the 2D / 3D script: ci wipes node_modules first and
      # fails with EPERM if anything has a file in it locked.
      & npm install;   if ($LASTEXITCODE) { throw 'npm install failed.' }
      & npm run build; if ($LASTEXITCODE) { throw 'npm run build failed.' }
    } finally { Pop-Location }
  }
  if (-not (Test-Path 'frontend\dist\index.html')) { throw 'frontend\dist is missing: run without -SkipBuild.' }

  # --- Package --------------------------------------------------------------
  $out = Join-Path $RepoRoot "dist\dist.$tag"
  $api = Join-Path $out 'publish\api'
  Info "Package: $out"
  if (Test-Path $out) { Remove-Item $out -Recurse -Force }
  & robocopy 'frontend\dist' $out /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy (dashboard) failed: $LASTEXITCODE" }
  & robocopy 'backend' $api /E /NFL /NDL /NJH /NJS /NP `
      /XD .venv .cache dev-share tests coordinates examples __pycache__ .pytest_cache `
      /XF appsettings.json requirements-dev.txt pytest.ini *.pyc | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy (api) failed: $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
  # The deploy script travels with the package (under publish\, which the dashboard never serves).
  Copy-Item 'deploy\Deploy-WaferMap.ps1' (Join-Path $out 'publish') -Force
  New-Item -ItemType Directory -Force (Join-Path $RepoRoot 'dist\seed') | Out-Null
  Copy-Item 'backend\coordinates\152-900530D.xlsx' (Join-Path $RepoRoot 'dist\seed\') -Force

  # --- Checks ---------------------------------------------------------------
  $checks = [ordered]@{
    'dashboard index.html'                = Test-Path "$out\index.html"
    'dashboard web.config (publish hidden)' = [bool](Select-String -Path "$out\web.config" -Pattern 'segment="publish"' -Quiet)
    'tab icon favicon.svg'                = Test-Path "$out\favicon.svg"
    'api app.py'                          = Test-Path "$api\app.py"
    'api web.config (placeholders)'       = [bool](Select-String -Path "$api\web.config" -Pattern '__API_DIR__' -Quiet)
    'deploy script in publish'           = Test-Path "$out\publish\Deploy-WaferMap.ps1"
    'NO appsettings.json in the package'  = -not (Test-Path "$api\appsettings.json")
  }
  $checks.GetEnumerator() | ForEach-Object { "{0,-40} {1}" -f $_.Key, $(if ($_.Value) { 'ok' } else { 'FAILED' }) }
  if ($checks.Values -contains $false) { throw 'Package checks failed (see above).' }

  Write-Host ''
  Info 'Package ready.'
  Write-Host "  Copy   $out"
  Write-Host "  to     <VM> S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence\dist.$tag"
  Write-Host "  e.g.   robocopy `"$out`" \\<VM>\S$\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence\dist.$tag /E /NFL /NDL /NP"
  Write-Host "  First deploy only: also copy $(Join-Path $RepoRoot 'dist\seed') to <app root>\seed and add -SeedBundledLayout"
  Write-Host "  Then on the VM (Administrator PowerShell):" -ForegroundColor Yellow
  Write-Host "    & 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence\dist.$tag\publish\Deploy-WaferMap.ps1' -Tag $tag" -ForegroundColor Yellow
} finally { Pop-Location }
