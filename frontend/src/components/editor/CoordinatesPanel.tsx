import { useMemo, useState } from 'react'
import type { LayoutKind } from '../../api/types'
import { fmt } from '../../format'
import { rowsProblem, type EditRow } from './coordinateRows'

interface Props {
  layoutName: string
  nextRevision: number
  kind: LayoutKind
  rows: EditRow[]
  changed: boolean
  busy: boolean
  onRowsChange: (rows: EditRow[]) => void
  onSave: (note: string) => void
  onCancel: () => void
}

const PAGE = 100

/* Edit a layout's coordinates in the browser: rows are paged (and can be
   filtered by die), the map redraws as you type, and saving sends the rows
   to the server, which validates them like an uploaded file. */
export function CoordinatesPanel({ layoutName, nextRevision, kind, rows, changed, busy, onRowsChange, onSave, onCancel }: Props) {
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [note, setNote] = useState('')
  const filtered = useMemo(() => (filter.trim() ? rows.filter((r) => r.die === filter.trim()) : rows), [rows, filter])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE)
  const problem = rowsProblem(rows, kind)

  const setCell = (id: number, key: keyof Omit<EditRow, 'id'>, value: string) =>
    onRowsChange(rows.map((r) => (r.id === id ? { ...r, [key]: value } : r)))
  const addRow = () => {
    const id = rows.reduce((m, r) => Math.max(m, r.id), -1) + 1
    const last = filtered[filtered.length - 1] ?? rows[rows.length - 1]
    const die = filter.trim() || last?.die || '1'
    const feature = kind === 'die' ? '1' : String(Math.max(0, ...rows.filter((r) => r.die === die).map((r) => Number(r.feature) || 0)) + 1)
    onRowsChange([...rows, { id, die, feature, x: last?.x ?? '0', y: last?.y ?? '0' }])
    setPage(Math.max(0, Math.ceil((filtered.length + 1) / PAGE) - 1))
  }

  return (
    <div className="editor-panel" data-testid="coordinates-panel">
      <section className="card">
        <div className="micro-label">Edit coordinates · {layoutName}</div>
        <div className="editor-toolbar">
          <input className="input" style={{ width: 130 }} type="text" placeholder="Filter by die #" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0) }} aria-label="Filter by die" />
          <button type="button" className="btn btn-sm" onClick={addRow}>+ Row</button>
          <span className="cell-muted">{fmt(filtered.length)} rows · page {page + 1}/{pages}</span>
          <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">‹</button>
          <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">›</button>
        </div>
        <div className="table-scroll editor-rows-scroll">
          <table className="editor-grid" data-testid="editor-rows">
            <thead><tr><th>Die</th>{kind !== 'die' && <th>Feature</th>}<th>X</th><th>Y</th><th></th></tr></thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id}>
                  <td><input aria-label={`Die of row ${r.id}`} value={r.die} onChange={(e) => setCell(r.id, 'die', e.target.value)} /></td>
                  {kind !== 'die' && <td><input aria-label={`Feature of row ${r.id}`} value={r.feature} onChange={(e) => setCell(r.id, 'feature', e.target.value)} /></td>}
                  <td><input aria-label={`X of row ${r.id}`} value={r.x} onChange={(e) => setCell(r.id, 'x', e.target.value)} /></td>
                  <td><input aria-label={`Y of row ${r.id}`} value={r.y} onChange={(e) => setCell(r.id, 'y', e.target.value)} /></td>
                  <td><button type="button" className="btn btn-sm icon-btn" onClick={() => onRowsChange(rows.filter((x) => x.id !== r.id))} aria-label={`Remove row ${r.id}`}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problem
          ? <div className="error-banner" role="alert" data-testid="rows-problem">{problem}</div>
          : <div className="chart-note">Values in the file's units (mm, or µm when beyond 1,000). The map redraws as you type.</div>}
        <div className="field">
          <label className="field-label" htmlFor="ed-coords-note">What changed</label>
          <input id="ed-coords-note" className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. moved die 12 by +0.5 mm in X" />
        </div>
        <div className="editor-toolbar">
          <button type="button" className="btn btn-accent" disabled={busy || !changed || problem !== null} onClick={() => onSave(note.trim())} data-testid="save-coordinates">
            Save as revision {nextRevision}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  )
}
