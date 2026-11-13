import type { CSSProperties } from 'react'
import type { WaferMap } from '../../api/types'
import { fmt } from '../../format'
import { codeSelected, stageKey, stageShown, type Selection } from './statusFilter'

interface Props {
  data: WaferMap
  selection: Selection
  onToggleCode: (code: string) => void
  onToggleStage: (code: string, stage: string | null) => void
  onClear: () => void
  /* Codes whose scrap stages are listed underneath. */
  expanded: ReadonlySet<string>
  onToggleExpand: (code: string) => void
  /* Size to match the map beside it (the list scrolls inside). */
  height: number
  width: number
  /* The map filter: open the builder, the applied filter's name, remove it. */
  onOpenFilter: () => void
  activeFilter: string | null
  onClearFilter: () => void
}

/* A funnel: the map filter button. */
function FunnelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.5 2.5h13l-5 6v4.5l-3 1.5v-6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

const NO_STAGE = '(no stage)'

/* The status / defect-code counts right next to the wafer map: its legend and
   its filter. Click codes to show only those (several at once). Any status with
   a recorded stage has a ▸ that lists its stages - scrap stages for a defect
   code, banked stages (PROCESS) for Good; click a stage to show only that
   status from that stage. "Show all" resets. */

/* Good units are banked at a stage (PROCESS); defective units are scrapped at one. */
function stageKind(status: string): 'banked' | 'scrap' {
  return status === 'Good' ? 'banked' : 'scrap'
}
export function StatusLegend({
  data, selection, onToggleCode, onToggleStage, onClear, expanded, onToggleExpand, height, width, onOpenFilter, activeFilter, onClearFilter,
}: Props) {
  const interactive = data.status === 'ok'
  const filtering = selection.size > 0
  const stagesOf = (code: string) => data.status_stages?.[code] ?? []
  // Name column as wide as the longest code, so every count sits right after its name.
  const nameWidth = Math.max(...data.status_counts.map((c) => c.status.length), 4) + 1
  const stageWidth = Math.max(...Object.values(data.status_stages ?? {}).flat().map((s) => (s.stage ?? NO_STAGE).length), 6) + 1

  return (
    <section className="status-legend" style={{ height, width }} aria-label="Status counts">
      <div className="status-list-head">
        {activeFilter ? (
          <span className="filter-chip" data-testid="active-filter" title={`Map filter: ${activeFilter}`}>
            <span className="filter-chip-name">{activeFilter}</span>
            <button type="button" aria-label="Remove map filter" onClick={onClearFilter}>✕</button>
          </span>
        ) : <span />}
        <span className="legend-head-actions">
          {filtering && <button type="button" className="link-btn" onClick={onClear} data-testid="show-all">Show all</button>}
          <button
            type="button"
            className={`btn btn-sm icon-btn ${activeFilter ? 'is-active' : ''}`}
            onClick={onOpenFilter}
            disabled={!interactive}
            aria-label="Map filters"
            title="Map filters"
            data-testid="open-filters"
          >
            <FunnelIcon />
          </button>
        </span>
      </div>
      <ul
        className="status-list"
        data-testid="status-counts"
        style={{ '--name-w': `${nameWidth}ch`, '--stage-w': `${stageWidth}ch` } as CSSProperties}
      >
        {data.status_counts.map((c) => {
          const stages = stagesOf(c.status)
          const kind = stageKind(c.status)
          const expandable = stages.some((s) => s.stage !== null)
          const open = expandable && expanded.has(c.status)
          const on = codeSelected(selection, c.status)
          const partly = !on && stages.some((s) => selection.has(stageKey(c.status, s.stage)))
          return (
            <li key={c.status}>
              <div className="status-line">
                <button
                  type="button"
                  className={`status-row ${on ? 'is-focused' : ''} ${partly ? 'is-partial' : ''} ${filtering && !on && !partly ? 'is-dimmed' : ''}`}
                  aria-pressed={on}
                  onClick={() => onToggleCode(c.status)}
                  disabled={!interactive}
                  title={interactive ? `${on ? 'Hide' : 'Show'} ${c.status}` : undefined}
                >
                  <span className="swatch" style={{ background: data.colors[c.status] }} />
                  <span className="status-name">{c.status}</span>
                  <span className="status-count">{fmt(c.count)}</span>
                </button>
                {expandable && (
                  <button
                    type="button"
                    className="expand-btn"
                    aria-expanded={open}
                    aria-label={`${open ? 'Hide' : 'Show'} ${kind} stages of ${c.status}`}
                    title={`${stages.length} ${kind} stage${stages.length === 1 ? '' : 's'}`}
                    onClick={() => onToggleExpand(c.status)}
                    data-testid={`expand-${c.status}`}
                  >
                    {open ? '▾' : '▸'}
                  </button>
                )}
              </div>
              {open && (
                <ul className="stage-list" aria-label={`${kind === 'banked' ? 'Banked' : 'Scrap'} stages of ${c.status}`}>
                  {stages.map((s) => {
                    const shown = stageShown(selection, c.status, s.stage)
                    return (
                      <li key={s.stage ?? ''}>
                        <button
                          type="button"
                          className={`status-row stage-row ${shown && filtering ? 'is-focused' : ''} ${filtering && !shown ? 'is-dimmed' : ''}`}
                          aria-pressed={selection.has(stageKey(c.status, s.stage))}
                          onClick={() => onToggleStage(c.status, s.stage)}
                          disabled={!interactive}
                          title={interactive ? `Show only ${c.status} ${kind === 'banked' ? 'banked at' : 'scrapped at'} ${s.stage ?? 'no recorded stage'}` : undefined}
                        >
                          <span className="stage-name">{s.stage ?? NO_STAGE}</span>
                          <span className="status-count">{fmt(s.count)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <div className="chart-note">
        {filtering
          ? `Showing ${fmt(selection.size)} selection${selection.size === 1 ? '' : 's'}.`
          : 'Click codes to show only those. ▸ lists stages: banked (PROCESS) for Good, scrap for defect codes.'}
      </div>
    </section>
  )
}
