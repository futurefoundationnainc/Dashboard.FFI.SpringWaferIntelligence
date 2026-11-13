#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Deploy (or redeploy) Wafer Defect Map Intelligence on the IIS VM from a package folder
  already copied there, end to end and idempotently - the steps of backend/DEPLOY.md, B to C.

.DESCRIPTION
  Layout (the 2D / 3D shape, on S:):

    <Root>\                                   S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence
      dist.<tag>\                             dashboard  -> IIS app /<AppAlias>          (pool Sentient.Dashboards)
      dist.<tag>\publish\api\                 API        -> IIS app /<AppAlias>/api      (pool WaferMapApiPool)
      layouts\  cache\  logs\                 data (DataDir = <Root>), outside every deploy folder
      seed\152-900530D.xlsx                   bundled layout, first deploy only

  What it does, in order (each step check-then-act, safe to re-run):
    1. checks: HttpPlatformHandler, Python, the package folder
    2. data folders + Modify for the API pool; Read & execute for IIS on the package
    3. the API's Python environment (.venv) from requirements.txt
    4. appsettings.json: copied from the deployment IIS currently runs, or created (asks for the SAS once)
    5. web.config placeholders -> this server's folders; the "publish" protection on the dashboard
    6. the API app pool (No Managed Code, AlwaysRunning)
    7. (first deploy) seeds the bundled layout into an EMPTY layouts\
    8. CUTOVER: points the two IIS apps at this package (creating them on a first deploy)
    9. restarts the API pool and checks /api/health; prints the rollback command

  Never touches the data folders' contents and never deletes an older deploy folder
  (that is your rollback). Never runs iisreset: other apps share this server.

.PARAMETER Tag
  The package to deploy: <Root>\dist.<Tag> (e.g. 9c1d2ab or 9c1d2ab-wip).

.PARAMETER SeedBundledLayout
  First deploy only: copy <Root>\seed\152-900530D.xlsx into layouts\ when layouts\ is empty.

.EXAMPLE
  & 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence\dist.9c1d2ab\publish\Deploy-WaferMap.ps1' -Tag 9c1d2ab
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Tag,
  [string]$Root = 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence',
  [string]$SiteName = 'Sentient.cloud',
  [string]$AppAlias = 'dashboard.waferdefectmapintelligence',
  [string]$DashboardPool = 'Sentient.Dashboards',
  [string]$ApiPool = 'WaferMapApiPool',
  [string]$Python = 'C:\Program Files\Python312\python.exe',
  [switch]$SeedBundledLayout
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

$d   = Join-Path $Root "dist.$Tag"
$api = Join-Path $d 'publish\api'
Import-Module WebAdministration -ErrorAction SilentlyContinue
if (-not (Get-Module WebAdministration)) { throw "The WebAdministration module isn't available (IIS Management Scripts and Tools)." }

# --- 1. Checks -----------------------------------------------------------------
Info 'Checks'
if (-not (Get-WebGlobalModule -Name httpPlatformHandler -ErrorAction SilentlyContinue)) {
  throw 'HttpPlatformHandler is not installed. Install it first (backend/DEPLOY.md, B1), no iisreset needed.'
}
if (-not (Test-Path $Python)) { throw "Python not found at $Python (pass -Python <path to python.exe>)." }
foreach ($f in "$d\index.html", "$d\web.config", "$api\app.py", "$api\web.config", "$api\requirements.txt") {
  if (-not (Test-Path $f)) { throw "Package incomplete: $f is missing. Copy the whole dist.$Tag folder from the build PC." }
}
if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue)) { throw "Site '$SiteName' not found." }
Ok "HttpPlatformHandler, Python ($Python) and the package dist.$Tag are present."

# --- 2. Folders + permissions --------------------------------------------------------
Info 'Data folders and permissions'
foreach ($f in 'layouts', 'cache', 'logs') {
  New-Item -ItemType Directory -Force (Join-Path $Root $f) | Out-Null
  & icacls (Join-Path $Root $f) /grant "IIS AppPool\${ApiPool}:(OI)(CI)M" /T /Q | Out-Null
  if ($LASTEXITCODE) { throw "icacls failed on $f" }
}
& icacls $d /grant 'IIS_IUSRS:(OI)(CI)RX' 'IUSR:(OI)(CI)RX' /T /Q | Out-Null
if ($LASTEXITCODE) { throw "icacls failed on $d" }
$global:LASTEXITCODE = 0
Ok "layouts\, cache\, logs\: Modify for $ApiPool | dist.$Tag : Read & execute for IIS"

# --- 3. Python environment ------------------------------------------------------
Info 'Python environment'
$venvPy = Join-Path $api '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) { & $Python -m venv (Join-Path $api '.venv'); if ($LASTEXITCODE) { throw 'venv creation failed.' } }
& $venvPy -m pip install --upgrade pip --quiet;                              if ($LASTEXITCODE) { throw 'pip upgrade failed.' }
& $venvPy -m pip install -r (Join-Path $api 'requirements.txt') --quiet;    if ($LASTEXITCODE) { throw 'pip install failed.' }
& $venvPy -c "import sys; sys.path.insert(0, r'$api'); import app; print('    app loads:', app.app.title, '| Python', sys.version.split()[0])"
if ($LASTEXITCODE) { throw 'The app does not import with this environment.' }

# --- 4. appsettings.json ----------------------------------------------------------
Info 'appsettings.json'
$settingsPath = Join-Path $api 'appsettings.json'
$currentApi = (Get-WebApplication -Site "$SiteName\$AppAlias" -Name 'api' -ErrorAction SilentlyContinue).PhysicalPath
if (-not (Test-Path $settingsPath)) {
  if ($currentApi -and (Test-Path (Join-Path $currentApi 'appsettings.json')) -and ($currentApi -ne $api)) {
    Copy-Item (Join-Path $currentApi 'appsettings.json') $settingsPath
    Ok "copied from the running deployment ($currentApi)"
  } else {
    $sec = Read-Host 'First deploy: paste the file-service SAS URL (https://<account>.file.core.windows.net/?sv=...)' -AsSecureString
    $sas = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    [ordered]@{ DataDir = $Root; FileShare = [ordered]@{ SasUrl = $sas.Trim(); ShareName = 'api-fileshare'; Root = 'risa'; LookbackDays = 365; SettledDays = 2; PrewarmDays = 14 } } |
      ConvertTo-Json -Depth 5 | Set-Content $settingsPath -Encoding UTF8
    Remove-Variable sas, sec
    Ok 'created (SettledDays 2; raise it while back-filling the share)'
  }
}
$cfg = Get-Content $settingsPath -Raw | ConvertFrom-Json
if ($cfg.DataDir -ne $Root) { $cfg | Add-Member -NotePropertyName DataDir -NotePropertyValue $Root -Force; $cfg | ConvertTo-Json -Depth 5 | Set-Content $settingsPath -Encoding UTF8 }
$sasOk = $cfg.FileShare.SasUrl -match '^https://[^/]+\.file\.core\.windows\.net/\?.*sig='
Ok "DataDir = $($cfg.DataDir) | share $($cfg.FileShare.ShareName)/$($cfg.FileShare.Root) | SettledDays $($cfg.FileShare.SettledDays) | SAS $(if ($sasOk) { 'set' } else { 'MISSING OR NOT A FILE-SERVICE URL' })"

# --- 5. web.config files -------------------------------------------------------------
Info 'web.config'
$wc = Join-Path $api 'web.config'
(Get-Content $wc -Raw).Replace('__API_DIR__', $api).Replace('__DATA_DIR__', $Root) | Set-Content $wc -Encoding UTF8
if (Select-String -Path $wc -Pattern '__API_DIR__|__DATA_DIR__' -Quiet) { throw "Placeholders left in $wc" }
[xml]$x = Get-Content "$d\web.config"
if (-not ($x.configuration.'system.webServer'.security.requestFiltering.hiddenSegments.add | Where-Object { $_.segment -eq 'publish' })) {
  $sec = $x.CreateElement('security'); $rf = $x.CreateElement('requestFiltering'); $hs = $x.CreateElement('hiddenSegments'); $add = $x.CreateElement('add'); $add.SetAttribute('segment', 'publish')
  [void]$hs.AppendChild($add); [void]$rf.AppendChild($hs); [void]$sec.AppendChild($rf); [void]$x.configuration.'system.webServer'.AppendChild($sec); $x.Save("$d\web.config")
}
Ok "API web.config points at dist.$Tag; dashboard hides publish\ (the SAS can never be served)"

# --- 6. API app pool ------------------------------------------------------------
Info "App pool $ApiPool"
if (-not (Test-Path "IIS:\AppPools\$ApiPool")) { New-WebAppPool -Name $ApiPool | Out-Null }
Set-ItemProperty "IIS:\AppPools\$ApiPool" -Name managedRuntimeVersion -Value ''
Set-ItemProperty "IIS:\AppPools\$ApiPool" -Name managedPipelineMode -Value 'Integrated'
Set-ItemProperty "IIS:\AppPools\$ApiPool" -Name startMode -Value 'AlwaysRunning'
Set-ItemProperty "IIS:\AppPools\$ApiPool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
Ok 'No Managed Code, Integrated, AlwaysRunning, no idle time-out'

# --- 7. Seed (first deploy) -----------------------------------------------------
if ($SeedBundledLayout) {
  $layouts = Join-Path $Root 'layouts'
  if (-not (Get-ChildItem $layouts -File -ErrorAction SilentlyContinue)) { Copy-Item (Join-Path $Root 'seed\152-900530D.xlsx') $layouts; Ok 'seeded 152-900530D.xlsx' }
  else { Ok 'layouts\ not empty: not seeded' }
}

# --- 8. Cutover: the two IIS applications -------------------------------------------
Info "IIS: /$AppAlias -> dist.$Tag"
$previousDash = (Get-WebApplication -Site $SiteName -Name $AppAlias -ErrorAction SilentlyContinue).PhysicalPath
if (-not $previousDash) {
  New-WebApplication -Site $SiteName -Name $AppAlias -PhysicalPath $d -ApplicationPool $DashboardPool | Out-Null
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName\$AppAlias" -Name physicalPath -Value $d
}
if (-not (Get-WebApplication -Site "$SiteName\$AppAlias" -Name 'api' -ErrorAction SilentlyContinue)) {
  New-WebApplication -Site "$SiteName\$AppAlias" -Name 'api' -PhysicalPath $api -ApplicationPool $ApiPool | Out-Null
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName\$AppAlias\api" -Name physicalPath -Value $api
  Set-ItemProperty "IIS:\Sites\$SiteName\$AppAlias\api" -Name applicationPool -Value $ApiPool
}
Get-WebApplication | Where-Object { $_.path -like "/$AppAlias*" } | ForEach-Object { Ok ("{0,-45} {1,-20} {2}" -f $_.path, $_.applicationPool, $_.PhysicalPath) }

# --- 9. Restart the API and check health -------------------------------------------
Info 'Restart API and health check'
if ((Get-WebAppPoolState -Name $ApiPool).Value -eq 'Started') { Stop-WebAppPool -Name $ApiPool; Start-Sleep -Seconds 3 }
Start-WebAppPool -Name $ApiPool
$health = $null
foreach ($b in Get-WebBinding -Name $SiteName | Where-Object { $_.protocol -match '^https?$' }) {
  $ip, $port, $hostName = $b.bindingInformation -split ':'; if (-not $hostName) { $hostName = 'localhost' }
  $u = "$($b.protocol)://$hostName$(if (($b.protocol -eq 'http' -and $port -ne '80') -or ($b.protocol -eq 'https' -and $port -ne '443')) { ":$port" })/$AppAlias/api/health"
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $health = Invoke-RestMethod $u -TimeoutSec 180; Ok "answered: $u"; break } catch { Write-Warning "no answer from $u : $($_.Exception.Message)" }
}
if ($health) {
  Ok "status: $($health.status) | dataDirConfigured: $($health.dataDirConfigured) | layouts writable: $($health.layoutsDir.writable) ($($health.layoutsDir.fileCount) files) | cache writable: $($health.cacheDir.writable) | share: $($health.fileShare.source), configured $($health.fileShare.configured)"
  if ($health.status -ne 'ok') { Write-Warning "health: $($health.error)" }
} else {
  Write-Warning 'The API did not answer. Last log lines:'
  Get-ChildItem (Join-Path $Root 'logs') -File | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 25
}

Write-Host ''
Info "Deployed dist.$Tag"
Write-Host "  Dashboard : /$AppAlias      -> $d   ($DashboardPool)"
Write-Host "  API       : /$AppAlias/api  -> $api   ($ApiPool)"
Write-Host "  Data      : $Root\layouts, cache, logs"
if ($previousDash -and $previousDash -ne $d) {
  Write-Host ''
  Write-Host '  Rollback (points IIS back at the previous deploy folder):' -ForegroundColor Yellow
  Write-Host "    Set-ItemProperty 'IIS:\Sites\$SiteName\$AppAlias' -Name physicalPath -Value '$previousDash'; Set-ItemProperty 'IIS:\Sites\$SiteName\$AppAlias\api' -Name physicalPath -Value '$previousDash\publish\api'; Restart-WebAppPool $ApiPool"
}
