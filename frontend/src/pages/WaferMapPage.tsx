import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { DieYieldTable } from '../components/wafer/DieYieldTable'
import { NoLayoutPanel } from '../components/wafer/NoLayoutPanel'
import { StatusLegend } from '../components/wafer/StatusLegend'
import { WaferMapChart } from '../components/wafer/WaferMapChart'
import { WaferSidebar } from '../components/wafer/WaferSidebar'
import { WaferToolbar } from '../components/wafer/WaferToolbar'
import { LEGEND_WIDTH, LEGEND_WIDTH_EXPANDED, pairLayout } from '../components/wafer/mapGeometry'
import { toggleCode, toggleStage, type Selection } from '../components/wafer/statusFilter'
import { FilterDialog, type AppliedFilter } from '../components/wafer/FilterDialog'
import { countsWithin, filterMask as buildFilterMask } from '../components/wafer/mapFilter'
import { fmt } from '../format'
import { useElementSize } from '../hooks/useElementSize'
import { useWaferMap } from '../hooks/useWaferMap'
import { DEFAULT_FEATURE } from '../terms'
import { layoutEditorHash } from '../router'
import type { ChartColors } from '../theme/chartColors'
import type { Theme } from '../theme/useTheme'

interface Props {
  colors: ChartColors
  /* The page's query string (`?sample=W305762.1&plan=3d`), from the dashboards' wafer-map icon. */
  search: string
  theme: Theme
  onToggleTheme: () => void
}

const STACKED_QUERY = '(max-width: 1100px)'

function isStacked(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(STACKED_QUERY).matches
}

export function readWaferQuery(search: string): { sample: string; plan: string | null } {
  const params = new URLSearchParams(search)
  const plan = (params.get('plan') ?? '').toLowerCase()
  return { sample: (params.get('sample') ?? '').trim(), plan: plan === '2d' || plan === '3d' ? plan : null }
}

/* The Wafer Map page: a slim toolbar, then the map with its status list filling
   the viewport on the left and the wafer details on the right; secondary tables
   follow below. This component only composes; fetching is in useWaferMap,
   drawing in WaferMapChart. */
export function WaferMapPage({ colors, search, theme, onToggleTheme }: Props) {
  const { sample, plan } = useMemo(() => readWaferQuery(search), [search])
  const { data, error, loading, reload } = useWaferMap(sample, plan)
  const [selection, setSelection] = useState<Selection>(() => new Set())
  const onToggleCode = useCallback((code: string) => setSelection((prev) => toggleCode(prev, code)), [])
  const onToggleStage = useCallback((code: string, stage: string | null) => setSelection((prev) => toggleStage(prev, code, stage)), [])
  const clear = useCallback(() => setSelection(new Set()), [])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const onToggleExpand = useCallback((code: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    return next
  }), [])
  const legendWidth = expanded.size > 0 ? LEGEND_WIDTH_EXPANDED : LEGEND_WIDTH
  const [filterOpen, setFilterOpen] = useState(false)
  const [applied, setApplied] = useState<AppliedFilter | null>(null)
  const applyFilter = useCallback((f: AppliedFilter) => {
    setApplied(f)
    setSelection(new Set()) // the list now counts inside the filter; start clean
    setFilterOpen(false)
  }, [])
  const clearFilter = useCallback(() => setApplied(null), [])
  const filterMask = useMemo(() => (applied && data ? buildFilterMask(applied.definition, data) : null), [applied, data])
  const legendData = useMemo(() => (data && filterMask ? { ...data, ...countsWithin(data, filterMask) } : data), [data, filterMask])
  const activeFilterLabel = applied ? `${applied.name}${applied.revision ? ` · rev ${applied.revision}` : ' (unsaved)'}` : null
  const [stageRef, stage] = useElementSize<HTMLDivElement>()
  const [pairHost, host] = useElementSize<HTMLDivElement>()
  const { side, mapColumn } = pairLayout({
    stageWidth: stage?.width ?? null, hostWidth: host?.width ?? null, hostHeight: host?.height ?? null, stacked: isStacked(), legendWidth,
  })
  const stageStyle = (mapColumn ? { '--map-col': `${mapColumn}px` } : {}) as CSSProperties
  const editorHref = layoutEditorHash(data?.product ?? '', data?.product_group ?? '', search)

  if (!sample) {
    return (
      <main className="wafer-page">
        <div className="error-banner" role="alert">
          No sample id in the link. The dashboards open this page as <code>?sample=W305762.1&amp;plan=3d</code>.
        </div>
      </main>
    )
  }

  return (
    <main className={`wafer-page ${loading ? 'loading-dim' : ''}`}>
      <WaferToolbar editorHref={editorHref} loading={loading} onReload={reload} theme={theme} onToggleTheme={onToggleTheme} />

      {(loading || error || !data) && (
        <section className="card wafer-status">
          <div className="micro-label">Wafer map{plan ? ` · ${plan.toUpperCase()}` : ''}</div>
          <h2 className="card-title">{sample}</h2>
          {loading && (
            <div className="sidebar-status" data-testid="wafer-loading">
              <span className="spinner" /> Searching the file share for the newest {plan ? `${plan.toUpperCase()} ` : ''}file of {sample}…
            </div>
          )}
          {error && <div className="error-banner" role="alert" data-testid="wafer-error">{error}</div>}
          {error && <button type="button" className="btn btn-sm" onClick={reload}>Try again</button>}
        </section>
      )}

      {data && (
        <>
          <div className="wafer-stage" ref={stageRef} style={stageStyle}>
            <section className="card wafer-stage-map">
              <div className="map-pair-host" ref={pairHost}>
                <div className="map-pair">
                  {data.status === 'ok' ? (
                    <WaferMapChart data={data} colors={colors} size={side} selection={selection} filterMask={filterMask} />
                  ) : (
                    <div style={{ width: side, height: side }} className="plot-square">
                      <NoLayoutPanel data={data} editorHref={editorHref} />
                    </div>
                  )}
                  <StatusLegend
                    data={legendData ?? data}
                    selection={selection}
                    onToggleCode={onToggleCode}
                    onToggleStage={onToggleStage}
                    onClear={clear}
                    expanded={expanded}
                    onToggleExpand={onToggleExpand}
                    height={side}
                    width={legendWidth}
                    onOpenFilter={() => setFilterOpen(true)}
                    activeFilter={activeFilterLabel}
                    onClearFilter={clearFilter}
                  />
                </div>
              </div>
              {data.status === 'ok' && (
                <div className="chart-note one-line" title={data.map?.caveat}>
                  {data.map?.caveat} {data.level === 'die' ? 'Dies drawn as cells at the grid pitch.' : `${(data.feature_label ?? DEFAULT_FEATURE).plural} drawn as 4 mm segments.`}
                  {data.farm_dies.length > 0 && ' Farm dies have a dotted outline and are left out of the yield.'}
                  {data.map && data.map.uninspected > 0 && ` ${fmt(data.map.uninspected)} layout positions have no observation in this file.`}
                </div>
              )}
            </section>
            <WaferSidebar data={data} />
          </div>
          {data.map?.die_yield && <DieYieldTable dieYield={data.map.die_yield} feature={data.feature_label ?? DEFAULT_FEATURE} />}
          {filterOpen && <FilterDialog data={data} active={applied} onApply={applyFilter} onClose={() => setFilterOpen(false)} />}
          <div className="footer-note">{data.caveat}</div>
        </>
      )}
    </main>
  )
}
