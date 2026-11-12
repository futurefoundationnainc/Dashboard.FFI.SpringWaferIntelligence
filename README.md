# Wafer Defect Map Intelligence — operational dashboard

Operationalized port of the `spring_wafer_app` Streamlit prototype into the
suite's standard shape: a pure-Python **analysis engine**, a **FastAPI**
service exposing it over typed JSON on a relative `/api`, and a
**React / Vite / TypeScript** frontend on the suite design system — plus an
adapter that ingests the customer's **CloudPCS XML** inspection exports.

```
   browser ── React/TS (Vite build) ── relative /api ── FastAPI (backend/app.py)
                                                             │
                                                      backend/engine/   (pure Python; no Streamlit)
                                                             │
                                          coordinates/ (product references)   examples/ (SYNTHETIC wafers)
```

Spring-level wafer inspection for probe cards: a 200 mm wafer holds gangs
(dies), each gang holds a few hundred microscopic springs, and inspection
grades each spring. Every spring is registered to its physical X/Y position
from a product coordinate reference, and defect patterns are analyzed across
one or many wafers.

> **Exploratory screening utility, not a validated manufacturing release
> decision system.** Spatial signatures are descriptive, not causal; spiral
> recognition is not automated; the coordinate center (bounding-box midpoint)
> and notch-down orientation are assumed and must be validated against
> physical fiducials. These caveats are shown in the UI, not buried here.

## Layout

```
backend/
  engine/
    reference.py      parse_reference (verbatim) / list_products / resolve_product / gang_bounds
    layouts.py        layout registry: preview, save, revisions, restore, product groups, hide
    inspection.py     read_inspection + validate_inspection (the original validation chain)
    analysis.py       stacked_summary, spatial_analysis, signature_indicators, header metrics
    gang_yield.py     PASS / SCRAP (> 60 %, strictly) / INCOMPLETE disposition
    xml_adapter.py    CloudPCS XML -> normalized frame (2D spring / 3D die exports; not SCRAP = Good; SCRAP = its DEFECT_CODE)
  wafermap/           Wafer Map page: iXML lookup on the file share (newest first), caches, settings
  app.py              FastAPI endpoints, sessions, caches, JSON marshaling only
  launch.py           one-process launcher (serves the built frontend)
  coordinates/        layouts: <name>.xlsx|csv + layouts.json registry (152-900530D.xlsx bundled)
  examples/           six SYNTHETIC example wafers for 152-900530D
  tests/              golden parity, domain rules, XML adapter, API contract
    fixtures/golden.json   pre-port values captured from the Streamlit functions
    tools/capture_golden.py  the capture script (reads reference-source/, never the port)
frontend/
  src/api/            client.ts (relative /api), types.ts (payload mirrors)
  src/charts/         waferFigures.ts — Plotly figure builders (wafer, stacked, heatmap)
  src/components/     controls, KPI cards, the five view panels, tables
  src/pages/          WaferMapPage (?sample=), LayoutsPage + LayoutHistory (#/layouts); router.ts
  src/theme/          suite design tokens (dark default / light), chart color resolution
reference-source/     the original Streamlit app, unmodified (parity reference)
deploy/               IIS sub-application: web.config (HttpPlatformHandler) + DEPLOY.md runbook
screenshots/          captured verification screenshots
```

## The five views

1. **Individual wafer** — each spring as a 4 mm horizontal segment at its real
   coordinate, colored Good `#21a653` / Low `#f4d43b` / Med `#f38a24` /
   Killer `#df3537` / Uninspected `#aab4c2`, gang outlines + die labels, wafer
   outline (100 mm radius) and notch marker; hover shows die, spring, status.
2. **Stacked wafer** — per-spring defect *frequency* (defects ÷ inspections)
   across the selected wafers; never-inspected springs are drawn at zero for
   rendering only and are explicit in the table.
3. **Spatial signatures** — Gaussian-smoothed incidence on a 2 mm grid (blank
   where coverage is insufficient), radial zones, outer angular sectors,
   indicator messages (including "spiral patterns are not labeled
   automatically"), hotspot peaks, and the binomial / Benjamini-Hochberg
   recurrence table with its exploratory caveat.
4. **Gang yield** — per-wafer per-gang bad fraction against the **reference**
   spring count; `SCRAP` when strictly > 60 %, `INCOMPLETE` when not fully
   inspected, else `PASS`; the rule is stated on screen.
5. **Export** — stacked spring metrics and normalized inspection data as CSV.

## Wafer Map page (`?sample=<id>&plan=2d|3d`)

The target of the **Wafer Map** icon next to every sample id in the 2D and 3D
Yield & Defect dashboards (`waferMapUrl` in their `data/links.json`, e.g.
`/wafermap/?sample={id}&plan=3d`). One click shows one wafer:

1. **Find the file (newest first).** The CloudPCS iXML exports live on the Azure
   Files share `api-fileshare` under `risa/{yyyy}/{yyyy_MM_dd}/` (~2,000 files a
   day). The backend (`backend/wafermap/`) walks day folders from today back,
   reads **file names only**, and takes the newest match; the first day with a
   match wins and the search stops. File names come from SentientRISAXMLIngest:
   `iXML#{n}_{DataCollectionPlan}_{yyyy_MM_dd_T_HH_mm_ss…}_MsgId_MET_{SAMPLEID without '.'}_….xml`,
   where the plan is `WaferYield_DefectMonitor` (**2D**) or `3D_YIELD_MONITOR`
   (**3D**). The `SAMPLEID` inside the file is checked after download.
2. **Parse it.** 2D exports are **spring-level** (`SPRING_GRADING`); 3D exports
   are **die-level** (`DIE_GRADE`, no `SPRING_NUM`, `FARM_DIE` = F for farm
   dies). Same rule for both: not `SCRAP` = Good, `SCRAP` = its `DEFECT_CODE`
   (`null` / `NONE` / blank -> `UNCODED`). Farm dies are outlined and left out
   of the yield.
3. **Match a layout** by exact `PRODUCT`, else by `PRODUCTGROUP`; the latest
   revision draws. **No layout -> the chart shows NO LAYOUT AVAILABLE** with an
   **Open Wafer Layout Editor** button (pre-filled with the product and group,
   and a way back). A layout whose keys do not cover the export shows LAYOUT
   DOES NOT MATCH THIS WAFER instead of a partial map.

Caching: past day-folder listings are kept on disk forever (the data never
changes), today's and yesterday's for 2 minutes; parsed exports are kept per
file (a 43 MB 2D export parses in ~3 s once, then loads in < 0.5 s). Settings
are environment variables, listed in `backend/wafermap/settings.py`
(`WAFERMAP_SAS_URL` is a secret: server-side only). Deployment on IIS:
[deploy/DEPLOY.md](deploy/DEPLOY.md).

## Wafer Layout Editor (`#/layouts`)

A layout is a product coordinate reference: one CSV/XLSX per physical design
(`Die_Num, Spring_Num, X, Y` in mm, one row per spring). The Layouts page lets
the customer manage them without touching the server:

1. **Upload** a coordinate file. It is parsed immediately (nothing stored) and
   the page shows spring / gang counts, springs per gang, inferred center,
   extents, max radius and sanity warnings (springs outside the 200 mm
   outline, uneven gangs, non-contiguous numbering).
2. **Visualize** the map before saving: every spring as a 4 mm segment with
   gang outlines and die labels, same renderer as the wafer map.
3. **Save** under a layout name plus the design / product names and product
   groups it serves (several designs share one layout), with your name and a
   note. Saving over an existing name (tick "Save as a new revision") adds a
   **revision**; a product or group already served by another layout is
   rejected.
4. **History / edit** any layout: view every revision on the map, **restore**
   one (adds a new revision copying it — history is never rewritten), **edit
   coordinates in the browser** (rows of Die, Spring, X, Y; saved as a new
   revision and validated like an upload) or change only its products / groups
   (also a revision). The latest revision always draws the maps.
5. **Hide** with confirmation instead of deleting: files and revisions stay,
   and **Bring back** restores the layout. Editing is open to everyone for now;
   revisions are the safety net.

**Two layout kinds.** A *spring* layout lists every spring of every gang
(`Die_Num, Spring_Num, X, Y`). A *die* layout has no spring level: one row per
die (`Die #, X, Y`, as in T11-style die maps). The engine treats each die as a
gang with a single spring (`Spring_Num = 1`), so stacking, spatial analysis
and gang yield run unchanged; the map draws dies as cells at the grid pitch
(the file carries no die dimensions, and the UI says so). Inspections for a
die product need no `Spring_Num` (CSV) / `SPRING_NUM` (XML). Column names are
matched loosely (`Die #`, `DIE_NUM`, `Gang Number`, `Spring #`, `x_um`, …) and
coordinates beyond 1,000 are read as micrometres and converted to mm.

Demo files in `backend/examples/layouts/`: `EXAMPLE-LAYOUT-A.csv` (128 gangs ×
160 springs), `EXAMPLE-LAYOUT-B.csv` (56 × 96), `EXAMPLE-DIE-LAYOUT.csv`
(64 dies, µm) and `EXAMPLE-LAYOUT-INVALID.csv` (duplicate key, rejected) are
**synthetic** designs generated by `make_example_layouts.py`;
`152-900530D.csv` is the bundled reference exported to CSV.

Storage: revision 1 is written to `coordinates/<layout>.<ext>`, later ones to
`coordinates/<layout>.rNNN.<ext>`, all registered in `coordinates/layouts.json`
(per layout: products, product groups, hidden flag and the revision list with
author, note, time, action and source file). `REF_DIR` moves the folder (on
IIS it lives outside the app folder; in Docker it is a volume). Both are
runtime data and git-ignored; only the bundled `152-900530D.xlsx` is tracked,
and files without a registry entry keep working as before (file stem =
product name, revision 1).

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/products` | products with a coordinate reference in `coordinates/` |
| `GET /api/reference/{product}` | spring coordinates (centered), inferred center, gang bounds |
| `POST /api/inspections` | multipart `product` + `files[]` (CSV / XLSX / CloudPCS XML); returns a session id and the wafer list, or **422 with every per-file error** and nothing loaded |
| `POST /api/examples` | load the bundled **synthetic** wafers into a session (`synthetic: true`) |
| `POST /api/analyze` | `{session_id, wafers?, bandwidth}` → header, individual, stacked, spatial, signature, gang_yield, caveats |
| `GET /api/sessions/{id}` | describe an existing session (used by the `?session=` deep link) |
| `GET /api/layouts` | saved layouts with summary (springs, gangs, center, warnings) |
| `POST /api/layouts/preview` | parse an uploaded coordinate file; returns geometry + summary, stores nothing |
| `POST /api/layouts` | multipart `file`, `name`, `products`, `product_groups` (comma / newline lists), `replace`, `author`, `note`, `action` (`upload` / `edit`) → new layout, or a new revision when `replace` |
| `GET /api/layouts/{name}` | one layout with its full revision history |
| `GET /api/layouts/{name}/revisions/{rev}` | one revision's coordinates (centered for drawing, source X / Y for editing) |
| `POST /api/layouts/{name}/restore` | `{rev, author, note}` → new revision copying `rev` |
| `POST /api/layouts/{name}/names` | `{products, product_groups, author, note}` → new revision, same coordinates |
| `POST /api/layouts/{name}/hidden` | `{hidden, author}` → hide / bring back (nothing is deleted) |
| `DELETE /api/layouts/{name}` | same as hiding (kept for compatibility) |
| `GET /api/wafermap?sample=&plan=` | the Wafer Map page: newest iXML for the sample, its counts, the matched layout and the map arrays; `status` = `ok` / `no_layout` / `layout_mismatch`; 404 when no file is found in the look-back window |
| `GET /api/wafermap/config` | where the page looks (never the SAS token) |
| `GET /api/export/stacked` / `GET /api/export/inspection` | the two CSV exports (`session_id`, repeated `wafers`) |

Charts are returned as **underlying arrays** (coordinates + status codes,
per-spring metrics, the smoothed rate grid oriented rows = y bins, zone /
sector / peak / recurrence / gang tables); the React side draws them with
Plotly. The parsed reference is cached per product and each analysis per
(session, wafer set, bandwidth).

## Run (two processes, same-origin /api via the Vite proxy)

```bash
# terminal 1 — API (http://localhost:8090)
backend/.venv/Scripts/python -m uvicorn app:app --app-dir backend --port 8090

# terminal 2 — UI (http://localhost:5187)
npm run dev --prefix frontend -- --port 5187 --strictPort
```

Setup: `py -3.13 -m venv backend/.venv`, then
`backend/.venv/Scripts/python -m pip install -r backend/requirements-dev.txt`
and `npm ci --prefix frontend`.

## Run (deployed shape, one origin)

```bash
npm run build --prefix frontend
backend/.venv/Scripts/python -m uvicorn app:app --app-dir backend --port 8090
```

FastAPI serves `frontend/dist` at `/` (mounted after the API routes, skipped if
no build exists; override with `STATIC_DIR`). `backend/launch.py` does the
same and opens the browser (`SPRING_WAFER_PORT`, default 8090).

Docker: `docker compose up -d --build spring-wafer-intelligence` → host port
8091. The optional `ngrok` demo tunnel runs with `--profile demo` and needs
`NGROK_AUTHTOKEN=` in `.env`.

## Tests

```bash
backend/.venv/Scripts/python -m pytest -q backend     # 85 tests: golden parity, domain rules, XML adapter, layouts, die layouts, API
npm run test --prefix frontend                        # vitest: figure geometry, rendering, interactions
npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run build --prefix frontend
```

### Golden parity

`backend/tests/fixtures/golden.json` holds the pre-port numbers for the six
synthetic wafers, captured by `tests/tools/capture_golden.py` directly from the
functions in `reference-source/spring_wafer_app/app.py` (lifted by AST; the
only Streamlit symbol they touch, `st.cache_data`, is stubbed to identity).
Three scenarios are pinned — all six wafers at 5 mm, the first three at 10 mm,
one wafer at 5 mm — and `test_golden.py` compares header metrics, every
per-spring stacked metric, the full smoothed rate grid, the baseline, the
hotspot table, the full recurrence table (p and q), zones, indicator messages,
the per-wafer per-gang disposition table and the individual status counts.

Headline values (six wafers, 5 mm): 20,952 springs in 108 gangs, center
(71.245, −0.5015) mm, 125,712 observations, 12.78 % defect rate, 6,036
covered grid cells, 5 hotspots, 0 scrapped gangs, 10 springs with q ≤ 0.05.

## Data

- `coordinates/152-900530D.xlsx` is the bundled reference. Add more through the
  Layouts page (or drop `PRODUCT.xlsx` / `.csv` into `coordinates/`; parenthetical
  header descriptions are stripped).
- `examples/` are **synthetic**, generated by
  `reference-source/spring_wafer_app/make_examples.py`; the UI labels them as
  such everywhere they appear.
- CloudPCS XML exports are accepted by the upload endpoint (`.xml`). They
  carry **no severity**, so an XML session uses the **defect-code status
  model** (customer rule, 2026-10-13): `SPRING_GRADING` other than `SCRAP` is
  `Good`; a `SCRAP` spring takes its `DEFECT_CODE` as its status (blank code
  becomes `UNCODED`). The individual map and tables are colored by code, with
  a provisional palette assigned by frequency (code meanings have not been
  supplied). Stacked, spatial and gang-yield views run unchanged on
  good-versus-defective. A product without a coordinate reference, or an
  export whose die/spring keys are not in the reference, is rejected with a
  specific message — nothing is partially rendered. XML and CSV files cannot
  be mixed in one upload.
- The first real export, `152-900530D` wafer `W304617.1` (20,952 rows, 108 × 194,
  every key in the reference, 16 defect codes, 29.3 % defective, 11 gangs over
  the 60 % rule), loads in about five seconds. It is customer data and is not
  committed; see `screenshots/08-11-*` for the rendered result.
- Deep links: `?view=stacked|spatial|gangs|export`, `?theme=dark|light`,
  `?session=<id>` (reopen a session created through the API).

## Ground rules

- The engine reproduces the Streamlit numbers exactly; do not "improve" the
  statistics, smoothing, thresholds or BH correction. Flag, don't fix.
- Uninspected ≠ Good. Scrap strictly > 60 % of the reference spring count.
- No fabricated data: no invented references, severities, coordinates or code meanings.
- No analysis logic in the API or the frontend.
- No individuals' names in code, comments or deliverables.
