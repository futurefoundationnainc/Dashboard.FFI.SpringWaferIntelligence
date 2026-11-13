# Deploy runbook — Wafer Map dashboard + API on IIS

Target: the **Sentient staging VM** (Windows Server 2019 / IIS 10), site
**Sentient.cloud**, beside the 2D / 3D Yield & Defect dashboards and other apps
(`/spc`, `/analytics`, …). Same shape and steps as the 2D / 3D runbook
(`server/GroupsApi/DEPLOY.md` in those repos); differences are listed at the end.
Every step is a shell command (PowerShell). First deployed 2026-11-13.

The dashboard is a static React build. The API is a Python (FastAPI) app run by
IIS's **HttpPlatformHandler**; it finds wafers' CloudPCS iXML files on the Azure
Files share and stores layouts, their revisions and the shared map filters as
files in a data folder outside every deploy folder.

## The layout

```
Sentient.cloud                                            (shared - production apps live here too)
└── /dashboard.waferdefectmapintelligence       → <Root>\dist.<tag>               [pool Sentient.Dashboards, static]
    └── /dashboard.waferdefectmapintelligence/api → <Root>\dist.<tag>\publish\api [pool WaferMapApiPool, No Managed Code, HttpPlatformHandler]

<Root> = S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence
    dist.<tag>\                 one folder per deploy (dashboard + publish\api\ + publish\Deploy-WaferMap.ps1)
    dist.<older tag>\           previous deploys - kept for rollback
    layouts\                    layouts.json, every layout revision, map_filters.json   <- LIVE USER DATA
    cache\                      share listings + parsed exports (safe to delete; rebuilt on demand)
    logs\                       stdout of the Python process (api_*.log)
    seed\152-900530D.xlsx       bundled layout, first deploy only
```

`<tag>` is the short commit hash the build came from, with `-wip` when the build PC had
uncommitted changes (so a folder never claims to be a commit it is not).

Rules that are load-bearing:

1. **The API is nested UNDER the dashboard app.** The page calls the API with a
   *relative* URL (`api/wafermap`, `frontend/src/api/client.ts`), so it resolves to
   `/dashboard.waferdefectmapintelligence/api/...`. Under the site root it would be
   `/api`, which is not ours.
2. **The data lives OUTSIDE every deploy folder** (`<Root>\layouts`, like the 2D / 3D
   `groups`), so a new `dist.<tag>` starts with every layout, and deleting an old deploy
   folder can never delete data.
3. **The dashboard never serves `publish\`.** As in 3D, the API sits inside the
   dashboard folder (`dist.<tag>\publish\api`). Unlike 3D's, our `appsettings.json` holds
   the **file-share SAS token**, so the dashboard's `web.config` (from
   `frontend/public/web.config`) has a `hiddenSegments` rule refusing any URL containing
   `publish`. The API itself is reached as `/…/api/…`, its own application, so the rule
   never touches it.

Public URLs (same origin as the dashboards, so **no CORS and no auth** — internal network only):

- `/dashboard.waferdefectmapintelligence/?sample=W305762.1&plan=3d` → the Wafer Map page (the dashboards' icon)
- `/dashboard.waferdefectmapintelligence/#/editor` → the Layout Editor
- `/dashboard.waferdefectmapintelligence/api/health` → deployment check (section C)

---

## A. Build and package (on the build PC)

From the repository root, in PowerShell:

```powershell
.\deploy\Package-WaferMap.ps1
```

It builds the dashboard (`npm install`, `npm run build`) and writes the package, in the
3D shape, to the git-ignored `dist\` folder of the repository:

```
<repo>\dist\dist.<tag>\                       dashboard: index.html, assets\, web.config, favicon.svg, sentient-mark.png
<repo>\dist\dist.<tag>\publish\api\           API: app.py, engine\, wafermap\, requirements.txt, web.config (placeholders)
<repo>\dist\dist.<tag>\publish\Deploy-WaferMap.ps1
<repo>\dist\seed\152-900530D.xlsx
```

It never packages `appsettings.json`, tests, samples, caches or `.venv`, and checks the
result (`ok` on every line). For a clean tag, commit first.

Copy the package to the VM (your usual method; this one works when the VM's admin share
is reachable — replace `<VM>` and `<tag>`):

```powershell
robocopy "C:\BDrive\repos\github\Dashboard.FFI.WaferDefectMapIntelligence\dist\dist.<tag>" "\\<VM>\S$\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence\dist.<tag>" /E /NFL /NDL /NP
```

First deploy only, also copy `dist\seed` to `<Root>\seed`.

---

## B. Server setup (one time) — Administrator PowerShell on the VM

### B1. HttpPlatformHandler and Python

HttpPlatformHandler is the IIS module that runs the Python API (the 2D / 3D APIs use
the .NET Hosting Bundle instead). Installed 2026-11-13; to install it on another
server — official Microsoft link, installed only if validly signed by Microsoft:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$msi = "$env:TEMP\httpPlatformHandler_amd64.msi"
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?LinkId=690721' -OutFile $msi -UseBasicParsing
$sig = Get-AuthenticodeSignature $msi
"signature: $($sig.Status) ($($sig.SignerCertificate.Subject))"
if ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -like '*O=Microsoft Corporation*') {
  (Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait -PassThru).ExitCode
}
"HttpPlatformHandler installed: $([bool](Get-WebGlobalModule -Name httpPlatformHandler -ErrorAction SilentlyContinue))"
```

**Do not run `iisreset`** — production apps share this server. It is not needed: the
module loads when the API's app pool starts.

Python: **3.12 or 3.13, 64-bit, installed for all users**. On the VM:
`C:\Program Files\Python312\python.exe` (check: `py -0p`).

### B2. The app folder on S:

```powershell
$root = 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence'
New-Item -ItemType Directory -Force $root, "$root\layouts", "$root\cache", "$root\logs" | Out-Null
"S: is a $((Get-Volume -DriveLetter S).DriveType) volume"   # must be Fixed: app pools cannot use mapped network drives
```

### B3. Everything else — the deploy script

With the package copied (section A), run:

```powershell
& 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence\dist.<tag>\publish\Deploy-WaferMap.ps1' -Tag <tag> -SeedBundledLayout
```

On a first deploy it asks once for the **file-service SAS URL** (input hidden, never
printed). It then does, in order, each step check-then-act:

| | Step | Detail |
|---|---|---|
| 1 | checks | HttpPlatformHandler, Python, the package |
| 2 | permissions | `layouts\`, `cache\`, `logs\`: **Modify** for `IIS AppPool\WaferMapApiPool`; `dist.<tag>\`: **Read & execute** for `IIS_IUSRS` and `IUSR` (nothing can write to a deploy folder) |
| 3 | Python | `.venv` in `publish\api` from `requirements.txt`; checks the app imports |
| 4 | `appsettings.json` | in `publish\api`: `DataDir = <Root>` + `FileShare` (SAS, `api-fileshare`, `risa`, LookbackDays 365, SettledDays 2, PrewarmDays 14). On a redeploy it is **copied from the deploy IIS currently runs** — never re-asked, never packaged |
| 5 | `web.config` | API: `__API_DIR__` / `__DATA_DIR__` → this deploy's folders. Dashboard: ensures the `publish` protection |
| 6 | app pool | `WaferMapApiPool`: No Managed Code, Integrated, AlwaysRunning, no idle time-out |
| 7 | seed | with `-SeedBundledLayout` and an **empty** `layouts\` only |
| 8 | **cutover** | creates, or re-points, `/dashboard.waferdefectmapintelligence` (pool Sentient.Dashboards) and the nested `/api` (pool WaferMapApiPool) to `dist.<tag>` |
| 9 | restart + health | restarts the API pool only, calls `/api/health`, prints the rollback command |

It never deletes a deploy folder, never touches the data folders' contents, never runs
`iisreset`.

<details><summary>The same steps by hand (what was run on 2026-11-13)</summary>

```powershell
$root = 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence'; $tag = '<tag>'
$d = "$root\dist.$tag"; $api = "$d\publish\api"

# Python environment
& 'C:\Program Files\Python312\python.exe' -m venv "$api\.venv"
& "$api\.venv\Scripts\python.exe" -m pip install -r "$api\requirements.txt" --quiet

# appsettings.json (the SAS is typed, not shown)
$sec = Read-Host 'file-service SAS URL' -AsSecureString
$sas = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
[ordered]@{ DataDir = $root; FileShare = [ordered]@{ SasUrl = $sas.Trim(); ShareName = 'api-fileshare'; Root = 'risa'; LookbackDays = 365; SettledDays = 2; PrewarmDays = 14 } } | ConvertTo-Json -Depth 5 | Set-Content "$api\appsettings.json" -Encoding UTF8
Remove-Variable sas, sec

# API web.config -> this server's folders
(Get-Content "$api\web.config" -Raw).Replace('__API_DIR__', $api).Replace('__DATA_DIR__', $root) | Set-Content "$api\web.config" -Encoding UTF8

# App pool
Import-Module WebAdministration
New-WebAppPool -Name WaferMapApiPool | Out-Null
Set-ItemProperty IIS:\AppPools\WaferMapApiPool -Name managedRuntimeVersion -Value ''
Set-ItemProperty IIS:\AppPools\WaferMapApiPool -Name startMode -Value AlwaysRunning
Set-ItemProperty IIS:\AppPools\WaferMapApiPool -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)

# Permissions
foreach ($f in 'layouts', 'cache', 'logs') { icacls "$root\$f" /grant "IIS AppPool\WaferMapApiPool:(OI)(CI)M" /T /Q }
icacls $d /grant "IIS_IUSRS:(OI)(CI)RX" "IUSR:(OI)(CI)RX" /T /Q

# Applications (nested: give the PARENT app as the site; a "parent/api" name is unreliable)
New-WebApplication -Site 'Sentient.cloud' -Name 'dashboard.waferdefectmapintelligence' -PhysicalPath $d -ApplicationPool 'Sentient.Dashboards'
New-WebApplication -Site 'Sentient.cloud\dashboard.waferdefectmapintelligence' -Name 'api' -PhysicalPath $api -ApplicationPool 'WaferMapApiPool'

# Seed the bundled layout (first deploy, empty layouts\ only)
if (-not (Get-ChildItem "$root\layouts" -File)) { Copy-Item "$root\seed\152-900530D.xlsx" "$root\layouts\" }
```

</details>

---

## C. Verify, in this order

Each step isolates one layer, so a failure tells you which one.

1. **Health** — proves the API runs, read its settings and can really write (it
   round-trips a probe file, so an ACL that only *looks* right is caught):

   ```powershell
   $h = Invoke-RestMethod 'http://localhost/dashboard.waferdefectmapintelligence/api/health' -TimeoutSec 180
   "status: $($h.status) | dataDirConfigured: $($h.dataDirConfigured) | layouts writable: $($h.layoutsDir.writable) unwritable: $($h.layoutsDir.unwritableFiles -join ',') | cache writable: $($h.cacheDir.writable) | share: $($h.fileShare.source)/$($h.fileShare.configured) | error: $($h.error)"
   ```

   Expected: `status: ok | dataDirConfigured: True | layouts writable: True unwritable: | cache writable: True | share: azure/True | error:`

   - *404?* the `api` app is not nested under the dashboard app (B3 step 8).
   - *500.19?* HttpPlatformHandler missing (B1), or `<modules>` locked (see the WebDAV note).
   - *502.3 / 502.5?* Python did not start: `Get-ChildItem <Root>\logs | Sort LastWriteTime | Select -Last 1 | Get-Content -Tail 25`
     names the reason (missing `.venv`, placeholders left in the API `web.config`).
   - `dataDirConfigured: False` → `appsettings.json` missing from the API folder or the pool was not restarted.
   - `unwritable` not empty → `attrib -R "<Root>\layouts\*"` and re-grant Modify with `/T`.

2. **The share and a wafer:**

   ```powershell
   $w = Invoke-RestMethod 'http://localhost/dashboard.waferdefectmapintelligence/api/wafermap?sample=W303495.1&plan=2d' -TimeoutSec 300
   "$($w.sample_id) | $($w.status) | $($w.product) | $($w.file.folder)/$($w.file.filename)"
   ```

   `ok` or `no_layout` both prove the share works. *"Could not list … on the file share"?* the SAS:
   expired, no list permission, or a share URL instead of the file-service URL.

3. **The page** — `https://<Sentient.cloud host>/dashboard.waferdefectmapintelligence/?sample=W303495.1&plan=2d`:
   the tab shows the Sentient mark and *Sentient© Build Smarter*; the map draws, or NO
   LAYOUT AVAILABLE.

4. **A save** — Layout Editor → select a layout → *Save as revision N*. *500?* permissions
   or `DataDir` (step 1 says which). *405?* WebDAV, below.

5. **The protection** — must be refused (404):
   `Invoke-WebRequest 'http://localhost/dashboard.waferdefectmapintelligence/publish/api/appsettings.json' -UseBasicParsing`

6. **A second machine** sees the same layouts and map filters (the shared store).

### The WebDAV 405

If reads work but **saving a map filter (PUT) or hiding a layout (DELETE)** fails with
**405 Method Not Allowed**, IIS's WebDAV module answered first. The API's `web.config`
removes `WebDAVModule` and the `WebDAV` handler for this application only (same fix as
the GroupsApi). If you see a 405, the deployed API `web.config` predates the fix: deploy
again. Check whether WebDAV is installed at all:
`& "$env:windir\system32\inetsrv\appcmd.exe" list module /name:WebDAVModule`.
If IIS answers **500.19** after the change, `<modules>` is locked at the server level:
`& "$env:windir\system32\inetsrv\appcmd.exe" unlock config /section:system.webServer/modules`.

---

## D. Redeploying

1. **Package on the build PC** (section A) — from an up-to-date `main`; prove the bundle
   has the change: `Select-String -Path dist\dist.<tag>\assets\index-*.js -Pattern '<text of the new UI>' -SimpleMatch -Quiet` → `True`.
2. **Copy** `dist.<tag>` to `<Root>` on the VM.
3. **Run** `& '<Root>\dist.<tag>\publish\Deploy-WaferMap.ps1' -Tag <tag>`.

The script builds the new `.venv`, copies `appsettings.json` from the deploy IIS is
running, prepares everything, then switches both apps to the new folder and restarts the
API pool only — a few seconds of API downtime; the 2D / 3D dashboards and the other apps
are untouched. Users don't need to clear their cache: `index.html` is served no-cache;
`assets\` files are content-hashed.

**Rollback:** the script prints the exact command; in general:

```powershell
$root = 'S:\SentientApps\DASHBOARD\Dashboard.FFI.WaferDefectMapIntelligence'; $prev = "$root\dist.<previous tag>"
Set-ItemProperty 'IIS:\Sites\Sentient.cloud\dashboard.waferdefectmapintelligence' -Name physicalPath -Value $prev
Set-ItemProperty 'IIS:\Sites\Sentient.cloud\dashboard.waferdefectmapintelligence\api' -Name physicalPath -Value "$prev\publish\api"
Restart-WebAppPool WaferMapApiPool
```

**Never** redeploy over, move or delete `<Root>\layouts` — live user data (layouts,
every revision, map filters). Old `dist.<tag>` folders can be deleted once you no longer
need them for rollback; never the one IIS points at
(`(Get-WebApplication -Name dashboard.waferdefectmapintelligence).PhysicalPath`).

## E. Operations

- **The 2D / 3D dashboards' wafer-map icon** — set in each dashboard's deployed
  `data\links.json` (done 2026-11-13 in `dist.9f59ba4` / `dist.e33e5fa`; backs up the file first):

  ```powershell
  $targets = @{
    'C:\SentientApps\Staging\DASHBOARD\Dashboard.FFI.YieldDefectIntelligence.3D\dist.<3D tag>' = '/dashboard.waferdefectmapintelligence/?sample={id}&plan=3d'
    'C:\SentientApps\Staging\DASHBOARD\Dashboard.FFI.YieldDefectIntelligence.2D\dist.<2D tag>' = '/dashboard.waferdefectmapintelligence/?sample={id}&plan=2d'
  }
  foreach ($dir in $targets.Keys) {
    $f = Join-Path $dir 'data\links.json'
    if (Test-Path $f) { Copy-Item $f "$f.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"; $cfg = Get-Content $f -Raw | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
    $cfg | Add-Member -NotePropertyName waferMapUrl -NotePropertyValue $targets[$dir] -Force
    $cfg | ConvertTo-Json -Depth 5 | Set-Content $f -Encoding UTF8
  }
  ```

  **Carry `links.json` over whenever 2D / 3D are redeployed or moved** — better, set
  `waferMapUrl` in those repos' `data\links.json`.
- **Backfill of the share** — while older days are still being uploaded, a day folder's
  listing must not be treated as final. Raise `FileShare.SettledDays` past the oldest day
  being filled (e.g. `60`); afterwards set it back to `2`, delete `<Root>\cache\listings`,
  `Restart-WebAppPool WaferMapApiPool`.
- **SAS rotation / the read-only SAS** — put the new URL in the running deploy's
  `appsettings.json` (same hidden prompt as B3 manual step), then
  `Restart-WebAppPool WaferMapApiPool`. The next deploy copies it forward.
- **Logs** — `<Root>\logs\api_*.log`.
- **Single process** — keep `--workers 1` in the API `web.config`: layout writes and the
  caches are in-process.

---

## Notes

- **Path traversal is blocked**: layout and filter names are validated
  (`[A-Za-z0-9 ._-]`, filters also `()<>=#&+`); file names from the share are reduced to
  one safe path component before caching.
- **Concurrent edits**: every save is a new revision, never an overwrite; the registry
  write is locked; hidden layouts and filters can be brought back.
- **web.config inheritance**: the dashboard's rules (no-cache, `publish` hidden) also apply
  to the nested API app, harmlessly — its URLs never contain `publish`. The API's handler and
  WebDAV removal sit in `<location path="." inheritInChildApplications="false">`.

## Running locally (no IIS needed)

1. **Development, hot reload** — `cd backend; .venv\Scripts\python -m uvicorn app:app --port 8090 --reload`
   and `cd frontend; npm run dev` → `http://localhost:5173/?sample=<id>&plan=2d` (Vite proxies `/api`).
   Without `appsettings.json` the API uses `backend\coordinates\` for layouts and
   `backend\dev-share\` as a stand-in for the share; set `WAFERMAP_SAS_URL` in that
   terminal to read the real share.
2. **The production bundle** — `npm run build`, then `backend\launch.py` (one process,
   served at the root).
3. **The IIS layout** — `npm run build`, the API on a free port, then
   `cd frontend; npm run serve:local -- --api-port <port>` → `http://localhost:8080/wafermap/`.
   `deploy\serve-local.mjs` (the 2D / 3D harness, adapted) reproduces the sub-path: the
   full-path forwarding HttpPlatformHandler does, the trailing-slash 301, and IIS hiding
   `web.config`. Don't deploy it.

---

## Differences from the 2D / 3D runbook

| | 2D / 3D (GroupsApi) | Wafer Map |
|---|---|---|
| Deploy folder | `C:\SentientApps\Staging\DASHBOARD\<repo>\dist.<commit>` | `S:\SentientApps\DASHBOARD\<repo>\dist.<tag>` (C: is short of space; 2D / 3D to move later) |
| API folder | `dist.<commit>\publish\api` | same |
| API runtime | .NET 8, ASP.NET Core Module (Hosting Bundle) | Python 3.12, HttpPlatformHandler |
| API build | `dotnet publish` produces web.config | files copied; `.venv` built on the VM; web.config checked in with placeholders |
| Path base | stripped by the ASP.NET Core Module | full path forwarded; the app infers it from `/api/` |
| Data | `S:\SentientApps\DASHBOARD\<repo>\groups` | `S:\…\<repo>\layouts`, `cache`, `logs` |
| Settings | `appsettings.json`: `GroupsDir` | `appsettings.json`: `DataDir`, `FileShare.*` — holds the SAS, so `publish\` is hidden |
| `/api/health` | `groupsDirConfigured`, `writable`, `unwritableGroups` | `dataDirConfigured`, `layoutsDir.writable` / `unwritableFiles`, `cacheDir`, `fileShare` |
| Pools | `Sentient.Dashboards` + `GroupsApiPool.2D/.3D` | `Sentient.Dashboards` + `WaferMapApiPool` |
| Script | `Deploy-Dashboard.ps1` (site-root layout) | `Package-WaferMap.ps1` (PC) + `Deploy-WaferMap.ps1` (VM, this layout, cutover + rollback) |
