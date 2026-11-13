import { useMemo, useState } from 'react'
import type { LayoutItem } from '../../api/types'
import { fmt } from '../../format'

interface Props {
  layouts: LayoutItem[]
  selected: string | null
  onSelect: (name: string) => void
  onNew: () => void
  /* The wafer's product / group when opened from a wafer map: matching layouts are flagged. */
  product: string
  group: string
}

function matches(l: LayoutItem, product: string, group: string): boolean {
  return (Boolean(product) && l.products.includes(product)) || (Boolean(group) && (l.product_groups ?? []).includes(group))
}

/* Every layout, searchable by name, product or group. Hidden ones on request. */
export function LayoutList({ layouts, selected, onSelect, onNew, product, group }: Props) {
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return layouts
      .filter((l) => showHidden || !l.hidden)
      .filter((l) => !q || [l.name, ...l.products, ...(l.product_groups ?? [])].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => Number(matches(b, product, group)) - Number(matches(a, product, group)) || a.name.localeCompare(b.name))
  }, [layouts, query, showHidden, product, group])

  return (
    <section className="card editor-list" aria-label="Layouts">
      <div className="status-list-head">
        <span className="micro-label">Layouts ({fmt(layouts.filter((l) => !l.hidden).length)})</span>
        <button type="button" className="btn btn-sm btn-accent" onClick={onNew} data-testid="new-layout">+ New layout</button>
      </div>
      <input className="input" type="search" placeholder="Search name, product or group" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search layouts" />
      <label className="checkbox-row" style={{ margin: '6px 0' }}>
        <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
        Show hidden
      </label>
      <ul className="editor-list-items" data-testid="layout-list">
        {shown.length === 0 && <li className="cell-muted">No layouts match.</li>}
        {shown.map((l) => (
          <li key={l.name}>
            <button
              type="button"
              className={`editor-list-item ${l.name === selected ? 'is-current' : ''} ${l.hidden ? 'row-hidden' : ''}`}
              onClick={() => onSelect(l.name)}
              aria-current={l.name === selected ? 'true' : undefined}
            >
              <span className="editor-list-name">
                <strong>{l.name}</strong>
                {matches(l, product, group) && <span className="match-pill" title="Matches the wafer you came from">this wafer</span>}
              </span>
              <span className="cell-muted">
                {l.summary ? (l.summary.kind === 'die' ? `Die map · ${fmt(l.summary.gangs)} dies` : `Feature map · ${fmt(l.summary.springs)} features`) : l.error ? 'unreadable' : ''}
                {` · rev ${l.revision ?? 1}`}{l.hidden ? ' · hidden' : ''}
              </span>
              <span className="editor-list-names">{[...l.products, ...(l.product_groups ?? []).map((g) => `group ${g}`)].join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
