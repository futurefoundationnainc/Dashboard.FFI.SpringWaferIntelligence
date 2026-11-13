# Theme — Wafer Defect Map Intelligence

The look-and-feel rules of this app: colour tokens, light / dark switching, chart
colours, the domain palettes, the two production pages' layout, and the shared
components. Companion to the 2D / 3D Yield & Defect dashboards'
`docs/THEME_VIEW_AND_SUMMARY_TABLES.md`; section 6 lists where this app follows
that spec and where it does not (yet).

React 18 + Vite + TypeScript, plain CSS (`frontend/src/theme/theme.css`), Plotly
for charts. Each section gives the **rules** (what must stay true), then where
the code lives. The rules matter more than the code.

---

## 0. Foundations

### 0.1 Colour tokens, dark and light

Every colour is a CSS custom property in `frontend/src/theme/theme.css`.
Components never hard-code a colour. **Dark is the default** (`:root`); light
overrides it under `[data-theme='light']` — the Sentient Navigator token set the
other operational dashboards use.

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--bg` | `#000000` | `#ffffff` | page |
| `--surface` / `--surface-2` | `#0a0a0a` / `#000000` | `#ffffff` | cards, plot background |
| `--inset` | `#101010` | `#f6f8fa` | inputs, empty / NO LAYOUT panels, hover labels |
| `--border` / `--border-muted` / `--border-strong` | `#262626` / `#1a1a1a` / `#3d3d3d` | `#d0d7de` / `#e6eaee` / `#afb8c1` | card edges, grid lines, dashed panels |
| `--hover` | `#171717` | `#f3f4f6` | row / button hover |
| `--text` / `--text-2` / `--text-3` | `#ffffff` / `#b8b8b8` / `#8a8a8a` | `#1f2328` / `#59636e` / `#818b98` | body / secondary / captions |
| `--accent` / `--accent-fg` / `--on-accent` | `#2f81f7` / `#58a6ff` / `#fff` | `#0969da` / `#0969da` / `#fff` | primary buttons, links, farm-die outline |
| `--sel` / `--sel-border` | `rgba(56,139,253,.15)` / `#2f81f7` | `#ddf4ff` / `#0969da` | selected rows, active filter, focused status |
| `--good` / `--warn` / `--bad` | `#3fb950` / `#d29922` / `#f85149` | `#1a7f37` / `#9a6700` / `#cf222e` | messages, SCRAP / INCOMPLETE, NO LAYOUT title |
| `--wafer-fill` / `--wafer-edge` | `#0d0d0d` / `#4d4d4d` | `#f6f8fa` / `#afb8c1` | wafer outline and notch |
| `--gang-outline` / `--gang-label` | `#5a6b7c` / `#8a98a8` | `#6e7d8c` / `#52647a` | die outlines and die numbers on maps |

**Rule:** a new colour is a new token, defined in **both** blocks. A colour defined
only for dark shows up unthemed in light.

### 0.2 Switching

- `data-theme` on `<html>`, set by `frontend/src/theme/useTheme.ts`; saved in
  `localStorage['theme']`; first visit follows `prefers-color-scheme`;
  `?theme=light|dark` in the URL forces one (screenshots, demos).
- The ☀ / ☾ button: in the Wafer Map page's top bar, the Layout Editor's top bar,
  and the prototype's header.

### 0.3 Chart colours come from the tokens

Plotly cannot resolve `var(--…)` inside figure JSON, so
`frontend/src/theme/chartColors.ts` reads the tokens at runtime
(`getComputedStyle`) into a `ChartColors` object, with theme-matched fallbacks for
tests. Every figure builder (`frontend/src/charts/waferFigures.ts`) takes
`ChartColors`. **Rule:** a chart never names a colour that is not either a token
(through `ChartColors`) or a domain palette (section 1).

### 0.4 Type and sizes

`body { font-size: 12.5px }`; component sizes are in `px` (cards 13–14 px padding,
micro-labels 10–11 px uppercase, card titles 15–16 px). See section 6 for the
`rem` rule of the 2D / 3D spec.

---

## 1. Domain palettes (deliberately NOT theme tokens)

They encode meaning, not decoration, and must look the same in both themes and in
every renderer, so the **API sends them** and the page only draws them.

- **Defect-code statuses (CloudPCS 2D / 3D):** `Good` `#21a653`; each defect code
  gets a colour by **frequency rank on that wafer** from a fixed list with no greens
  (`#df3537`, `#f38a24`, `#f4d43b`, `#8e44ad`, `#1f77b4`, …; `backend/app.py`,
  `DEFECT_CODE_PALETTE`), so Good is never confused with a defect; `Uninspected`
  `#aab4c2`.
- **Severity statuses (prototype CSV uploads):** Good `#21a653` / Low `#f4d43b` /
  Med `#f38a24` / Killer `#df3537` / Uninspected `#aab4c2`.
- **Rates (defect frequency, smoothed incidence):** Plotly `YlOrRd`, 0 → 1;
  `frontend/src/charts/dieCells.ts` reproduces it for die cells drawn as shapes.
- **Hidden / filtered-out units:** spring traces are omitted; die cells keep their
  outline with `rgba(0,0,0,0)` fill so the die grid stays readable.
- **Farm dies (3D `FARM_DIE = F`):** status colour + dotted `--accent-fg` outline.

---

## 2. Page layouts (production)

### 2.1 Wafer Map page (`?sample=<id>&plan=2d|3d`)

Rules:

- **No app header.** Opened from the dashboards' icon; a slim right-aligned
  toolbar (Layout Editor · ↻ Reload · ☀/☾) is the only chrome.
- **The map is the largest square that fits.** The row fills the viewport below the
  toolbar (`calc(100vh - 60px)`); the map side = min(available height, width left
  after the status list and the details column's 340 px minimum).
  `frontend/src/components/wafer/mapGeometry.ts` (pure, tested).
- **The status list is part of the map unit**, 12 px from it, and the same height:
  170 px wide (240 px while stages are expanded); counts sit right after the longest
  name (`--name-w`), not at the far edge.
- **The map card hugs map + list**; the details card takes all remaining width. No
  dead space beside the wafer.
- Under 1100 px the details move below; map and list stay side by side.
- Details card: sample id first (no "Wafer · 2D" label), then CollectionPlan,
  Product, Group, Layout · rev, Orientation, Yield, Scrapped, Dies, Inspected; a
  Source card below. Secondary tables (die disposition) follow below the fold.

### 2.2 Layout Editor (`#/editor`)

- Same headless shape: a toolbar (title · *Editing as* · ← Back to wafer map · ☀/☾).
- Three columns filling the viewport: layouts list (280 px) · square map (fills) ·
  details / upload / coordinates (420 px). 1300 px: 240 / fill / 360. Under 1050 px:
  stacked.
- The page is a flex column exactly one screen tall (`calc(100vh - 34px)`), so
  banners above the columns shrink the columns instead of pushing the page past the
  screen.

### 2.3 Prototype (workbench `#/`, layouts `#/layouts`)

Kept for testing concepts, not production; header bar with title and navigation.

---

## 3. Components and their classes

| Piece | Class(es) | Rules |
|---|---|---|
| Card | `.card`, `.card-header`, `.card-title`, `.micro-label` | surface + 1 px border, 8 px radius; micro-labels uppercase 10–11 px `--text-3` |
| Facts list | `dl.facts` | two columns, label `--text-3`; long values `.break` |
| Buttons | `.btn`, `.btn-sm`, `.btn-accent`, `.icon-btn`, `.link-btn` | one primary (`btn-accent`) per panel; icon buttons carry an `aria-label` |
| Status list | `.status-row` + `.is-focused` / `.is-dimmed` / `.is-partial`; `.stage-row` | focused = `--sel` fill + border; partial (some stages) = dashed border; others dimmed to 45 % while filtering; `aria-pressed` |
| Filter | `.filter-chip`, `.icon-btn.is-active` | the active filter is always visible beside the list; ✕ removes it |
| Modal | `.modal-backdrop`, `.modal` | Escape and a backdrop click close; `role="dialog"` + `aria-modal` |
| Empty / NO LAYOUT | `.editor-empty`, `.no-layout` | dashed `--border-strong` on `--inset`; title `--bad`; one primary action |
| Banners | `.warning-banner`, `.error-banner` | success = warning banner with `--good` left edge |

---

## 4. Wording

- **Wafer → Die → Feature.** A feature is the unit inside a die (a spring on 2D
  wafers); 3D wafers have no feature level. One source: `frontend/src/terms.ts`;
  the API sends `feature_label`, so a layout can rename features later.
- File-format names stay as the customer writes them (`SPRING_NUM`, `Spring_Num`),
  explained where they appear ("Spring_Num (the feature number)").
- App name: **Wafer Defect Map Intelligence**.

---

## 5. Checklist (for a change to either page)

- [ ] Every new colour is a token in both theme blocks, or a domain palette from the API.
- [ ] Charts get colours through `ChartColors`, never literals.
- [ ] Both themes checked by eye.
- [ ] At 1600×900 and 1366×768: the whole wafer visible without scrolling, no sideways
      scroll, list beside the map (`scrollWidth === innerWidth`).
- [ ] At 1024 wide: details below, map and list still side by side.
- [ ] New buttons have text or an `aria-label`; toggles use `aria-pressed` / `aria-expanded`.
- [ ] User-facing words follow section 4.

## 6. Relation to the 2D / 3D theme spec

| 2D / 3D rule (`THEME_VIEW_AND_SUMMARY_TABLES.md`) | Here |
|---|---|
| 0.2 Every colour a token, defined light **and** dark | **Followed** (dark default + light override; same Navigator palette family) |
| Theme via `data-theme` on `<html>`, ☀ / 🌙, saved in localStorage | **Followed** |
| 0.1 Every font size / padding in `rem` from one `:root` size | **Not yet** — sizes are `px`. Needed before a Font-size slider can work. |
| 1. ◐ View popup (chart size / font size) | **Not yet** — the map already sizes itself to the screen; a font slider would need 0.1 first. |
| 2. Summary tables (sticky header, stripes, yellow hover, nested rows) | **Partly** — the status list has nested stage rows; tables (`DataTable`, die disposition) use plain sticky-header tables without the yellow hover. |
| 3. Folder tabs | **Not applicable** to the production pages (no tab bars); the prototype uses plain tabs. |
| 4. Card help "?" | **Not yet.** |

Known literal colours to tokenise: `.modal-backdrop` uses `rgba(0,0,0,0.45)`; the
prototype's stacked die figure uses `#aab4c2` for uninspected (same as the domain
palette, but written inline).

## 7. Pitfalls already hit (don't repeat them)

| Pitfall | Fix |
|---|---|
| Plotly ignored `var(--token)` colours. | Resolve tokens to strings at runtime (`chartColors.ts`). |
| Map stuck at its 640 px fallback in a background tab: `ResizeObserver` reports only on a rendered frame. | Measure once with `getBoundingClientRect` when the element mounts, then observe (`useElementSize`). |
| Map card measured before data arrived, so never re-measured. | Callback ref, so the observer attaches when the element appears. |
| Legend with 18+ codes ate several rows of the map. | Plotly legend off; the status list beside the map is the legend. |
| Counts far from their codes, dead space beside a height-bound map. | Fixed-width list with a name column sized to the longest code; map card hugs its content, details take the rest. |
| A banner pushed the editor past the screen. | Page as a flex column one screen tall; columns take what is left. |
| Same URL navigation did not reload new CSS during checks. | Hash-only changes don't reload; force a reload when verifying a build. |
