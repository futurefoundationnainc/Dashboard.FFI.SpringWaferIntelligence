# Deploy runbook — Wafer Map on IIS

Target: **Windows Server 2019 / IIS 10**, the same kind of host as the 2D and 3D
Yield & Defect dashboards. The Wafer Map runs as **one IIS sub-application**
(`/wafermap`) whose single Python process (FastAPI + uvicorn, started by
**HttpPlatformHandler**) serves both the API and the built React page.

```
Default Web Site                         (shared — the dashboards live here too)
├── /yielddashboard …                     (existing 2D / 3D dashboards)
└── /wafermap  → C:\inetpub\wafermap      [Application, No Managed Code, HttpPlatformHandler]
      backend\        app.py, engine\, wafermap\, .venv\
      frontend\dist\  built page
      web.config      (from deploy\iis\web.config)

C:\WaferMapData\                          (OUTSIDE the app folder — survives redeploys; back it up)
├── coordinates\   layouts.json + every layout revision file
├── cache\         day-folder listings + parsed exports (safe to delete)
└── logs\          wafermap.log (stdout of the Python process)
```

Public URLs (same origin as the dashboards, so no CORS):

| URL | What |
|---|---|
| `/wafermap/?sample=W305762.1&plan=3d` | the Wafer Map page for one sample (what the dashboards link to) |
| `/wafermap/#/layouts` | the Wafer Layout Editor |
| `/wafermap/api/health` | health check |
| `/wafermap/api/wafermap?sample=…&plan=2d\|3d` | the page's data |

## A. One-time server setup

1. **HttpPlatformHandler** — install the IIS module (Web Platform Installer or the
   `httpPlatformHandler_amd64.msi` from Microsoft). Check: IIS Manager → server →
   *Modules* lists `httpPlatformHandler`.
2. **Python 3.12 or 3.13 (64-bit)**, installed for all users, e.g. `C:\Program Files\Python313\`.
3. **Folders** and permissions — the app pool identity
   (`IIS AppPool\wafermap`) needs **Modify** on `C:\WaferMapData` and
   **Read & execute** on `C:\inetpub\wafermap`:

   ```powershell
   New-Item -ItemType Directory -Force C:\inetpub\wafermap, C:\WaferMapData\coordinates, C:\WaferMapData\cache, C:\WaferMapData\logs
   ```
4. **App pool** `wafermap`: *.NET CLR version* = **No Managed Code**, *Start mode* =
   AlwaysRunning (keeps the listing cache warm), *Idle time-out* = 0.
5. **Application**: Default Web Site → Add Application → alias `wafermap`, pool
   `wafermap`, physical path `C:\inetpub\wafermap`.
   ```powershell
   icacls C:\WaferMapData /grant "IIS AppPool\wafermap:(OI)(CI)M"
   icacls C:\inetpub\wafermap /grant "IIS AppPool\wafermap:(OI)(CI)RX"
   ```
6. **Seed the layouts** (first deploy only — never overwrite later, it holds every revision):
   ```powershell
   Copy-Item backend\coordinates\152-900530D.xlsx C:\WaferMapData\coordinates\
   ```

## B. Build (any machine with Node 20+)

```sh
cd frontend
npm ci
npm run build          # -> frontend/dist, relative asset URLs (sub-path safe)
```

## C. Deploy / update

1. Stop the app pool (`Stop-WebAppPool wafermap`).
2. Copy `backend\app.py`, `backend\launch.py`, `backend\requirements.txt`,
   `backend\engine\`, `backend\wafermap\` to `C:\inetpub\wafermap\backend\`, and
   `frontend\dist\` to `C:\inetpub\wafermap\frontend\dist\`. Do **not** copy
   `backend\coordinates`, `backend\.cache`, `backend\dev-share` or `backend\.venv`.
3. Create / refresh the virtual environment:
   ```powershell
   cd C:\inetpub\wafermap\backend
   & "C:\Program Files\Python313\python.exe" -m venv .venv
   .\.venv\Scripts\python.exe -m pip install --upgrade pip
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
4. First deploy: copy `deploy\iis\web.config` to `C:\inetpub\wafermap\web.config`
   and set **`WAFERMAP_SAS_URL`** there (the Azure Files *file service* SAS URL —
   `https://<account>.file.core.windows.net/?sv=…&sig=…`). Use a **read + list**
   SAS. Later deploys: keep the server's `web.config` (it holds the secret).
5. Start the app pool and check:
   ```powershell
   Start-WebAppPool wafermap
   Invoke-RestMethod http://localhost/wafermap/api/health          # {"status":"ok"}
   Invoke-RestMethod http://localhost/wafermap/api/wafermap/config # where it looks (no secret)
   ```
   Then open `http://localhost/wafermap/?sample=<a recent sample>&plan=3d`.

## D. Point the dashboards at it

In each dashboard's `data/links.json` (no rebuild needed):

```jsonc
// Dashboard.FFI.YieldDefectIntelligence.3D
"waferMapUrl": "/wafermap/?sample={id}&plan=3d"
// Dashboard.FFI.YieldDefectIntelligence.2D
"waferMapUrl": "/wafermap/?sample={id}&plan=2d"
```

The dashboards' `buildLinkUrl` allows same-origin `/path` templates and URL-encodes
the sample id. Leaving out `&plan=` searches both monitors and shows the newest file.

## E. Operations

* **SAS expiry** — the current token expires **2027-01-01**. When it lapses the page
  shows "Could not list … on the file share". Update `WAFERMAP_SAS_URL` in
  `web.config`; IIS restarts the process.
* **Search window** — `WAFERMAP_LOOKBACK_DAYS` (default 365) bounds the newest-first
  walk. Day folders older than `WAFERMAP_SETTLED_DAYS` (default 2) are listed once and
  cached on disk for good (the data does not change); newer ones are re-listed every
  `WAFERMAP_LIVE_TTL_SECONDS`. A folder that does not exist is never cached, so a late
  or back-filled day is picked up automatically.
* **Backfills** — while old days are still being uploaded, raise `WAFERMAP_SETTLED_DAYS`
  past the oldest day being filled (e.g. `60`), or a half-uploaded folder's listing is
  kept as final. Afterwards set it back to `2` and delete `C:\WaferMapData\cache\listings`.
* **Cache** — `C:\WaferMapData\cache` can be deleted at any time (stop the pool first);
  it is rebuilt on demand. Parsed exports are kept; raw XML downloads are deleted
  after parsing.
* **Layouts** — `C:\WaferMapData\coordinates` is the only state that matters. Back it
  up with the server. Revisions are never deleted; "Hide" only hides.
* **Single process** — keep `--workers 1`: layout writes and the caches are
  in-process. One process handles the load of a click-through page comfortably.
* **Logs** — `C:\WaferMapData\logs\wafermap*.log`.

## F. Run locally (no IIS)

```powershell
cd backend
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
# Optional: a local stand-in for the share, same folder layout:
#   backend\dev-share\risa\2026\2026_10_31\iXML#….xml
$env:WAFERMAP_SOURCE = "local"          # or set WAFERMAP_SAS_URL to read the real share
.\.venv\Scripts\python.exe launch.py    # http://127.0.0.1:8090/?sample=W305463.5&plan=3d
```
