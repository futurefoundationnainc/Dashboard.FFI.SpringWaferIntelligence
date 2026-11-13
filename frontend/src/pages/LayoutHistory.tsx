import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { LayoutDetail, LayoutGeometry } from '../api/types'
import { buildLayoutFigure } from '../charts/waferFigures'
import { PlotlyChart } from '../components/PlotlyChart'
import { fmt } from '../format'
import type { ChartColors } from '../theme/chartColors'

interface Props {
  name: string
  colors: ChartColors
  author: string
  onChanged: () => void | Promise<void>
  onClose: () => void
}

interface EditRow {
  id: number
  die: string
  spring: string
  x: string
  y: string
}

const PAGE = 100
const ACTION_LABEL: Record<string, string> = { upload: 'Uploaded file', edit: 'Edited in browser', restore: 'Restored', names: 'Changed names' }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function splitNames(value: string): string[] {
  return value.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)
}

function when(value: string | null): string {
  if (!value) return 'pre-existing file'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/* CSV the backend parses with the same rules as an uploaded file. */
export function rowsToCsv(rows: EditRow[], kind: 'spring' | 'die'): string {
  const header = kind === 'die' ? 'Die_Num,X,Y' : 'Die_Num,Spring_Num,X,Y'
  const lines = rows.map((r) => (kind === 'die' ? [r.die, r.x, r.y] : [r.die, r.spring, r.x, r.y]).map((v) => v.trim()).join(','))
  return [header, ...lines].join('\n') + '\n'
}

function toRows(g: LayoutGeometry): EditRow[] {
  return g.die.map((d, i) => ({ id: i, die: String(d), spring: String(g.spring[i]), x: String(g.source_x[i]), y: String(g.source_y[i]) }))
}

/* Revision history of one layout: view any revision, restore it (as a new
   revision), edit the current one in the browser, or change which products /
   groups it serves. Nothing is ever overwritten. */
export function LayoutHistory({ name, colors, author, onChanged, onClose }: Props) {
  const [detail, setDetail] = useState<LayoutDetail | null>(null)
  const [rev, setRev] = useState<number | null>(null)
  const [geometry, setGeometry] = useState<LayoutGeometry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<EditRow[]>([])
  const [rowsChanged, setRowsChanged] = useState(false)
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [products, setProducts] = useState('')
  const [groups, setGroups] = useState('')
  const [note, setNote] = useState('')

  const loadDetail = useCallback(async (selectRev?: number) => {
    setBusy('load')
    try {
      const d = await api.layout(name)
      setDetail(d)
      setProducts(d.products.join(', '))
      setGroups((d.product_groups ?? []).join(', '))
      setRev(selectRev ?? d.revision ?? 1)
      setError(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }, [name])

  useEffect(() => {
    setEditing(false)
    setMessage(null)
    void loadDetail()
  }, [loadDetail])

  useEffect(() => {
    if (rev === null) return
    let cancelled = false
    api.layoutRevision(name, rev)
      .then((g) => { if (!cancelled) { setGeometry(g); setError(null) } })
      .catch((err) => { if (!cancelled) { setGeometry(null); setError(errorText(err)) } })
    return () => { cancelled = true }
  }, [name, rev])

  const figure = useMemo(() => (geometry ? buildLayoutFigure(geometry, colors, true) : null), [geometry, colors])
  const current = detail?.revision ?? null
  const viewingCurrent = rev !== null && rev === current

  const startEdit = () => {
    if (!geometry) return
    setRows(toRows(geometry))
    setRowsChanged(false)
    setFilter('')
    setPage(0)
    setNote('')
    setEditing(true)
    setMessage(null)
  }

  const filtered = useMemo(() => {
    const f = filter.trim()
    return f ? rows.filter((r) => r.die === f) : rows
  }, [rows, filter])
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))

  const setCell = (id: number, key: keyof Omit<EditRow, 'id'>, value: string) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: value } : r)))
    setRowsChanged(true)
  }
  const addRow = () => {
    const last = rows[rows.length - 1]
    const id = rows.reduce((m, r) => Math.max(m, r.id), -1) + 1
    setRows((rs) => [...rs, { id, die: filter.trim() || last?.die || '1', spring: '1', x: '0', y: '0' }])
    setRowsChanged(true)
    setPage(Math.max(0, Math.ceil((filtered.length + 1) / PAGE) - 1))
  }
  const removeRow = (id: number) => {
    setRows((rs) => rs.filter((r) => r.id !== id))
    setRowsChanged(true)
  }

  const namesChanged = detail !== null && (
    splitNames(products).join('|') !== detail.products.join('|') || splitNames(groups).join('|') !== (detail.product_groups ?? []).join('|')
  )

  const saveEdits = async () => {
    if (!detail || !geometry) return
    setBusy('save')
    setError(null)
    try {
      let item
      if (rowsChanged) {
        const csv = rowsToCsv(rows, geometry.kind)
        const file = new File([csv], `${detail.name}-edited.csv`, { type: 'text/csv' })
        item = await api.saveLayout({
          name: detail.name, products: splitNames(products).join(', '), productGroups: splitNames(groups).join(', '),
          replace: true, file, author, note, action: 'edit',
        })
      } else {
        item = await api.updateLayoutNames(detail.name, splitNames(products), splitNames(groups), author, note)
      }
      setEditing(false)
      setMessage(`Saved revision ${item.revision}.`)
      await loadDetail(item.revision)
      await onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const restore = async (r: number) => {
    setBusy('restore')
    try {
      const item = await api.restoreLayout(name, r, author)
      setMessage(`Revision ${r} restored as revision ${item.revision}.`)
      await loadDetail(item.revision)
      await onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const kind = geometry?.kind ?? 'spring'

  return (
    <section className="card" style={{ marginBottom: 14 }} data-testid="layout-history">
      <div className="card-header">
        <div>
          <div className="micro-label">Layout history{detail?.hidden ? ' · hidden' : ''}</div>
          <h2 className="card-title">{name}{current !== null ? ` · current revision ${current}` : ''}</h2>
        </div>
        <div className="card-actions">
          {viewingCurrent && !editing && (
            <button type="button" className="btn btn-sm btn-accent" disabled={!geometry || busy !== null} onClick={startEdit} data-testid="edit-layout">
              Edit in browser
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      {error && <div className="error-banner" role="alert" data-testid="history-error">{error}</div>}
      {message && <div className="warning-banner" role="status" style={{ borderLeftColor: 'var(--good)' }} data-testid="history-message">✓ {message}</div>}

      {editing && geometry ? (
        <div data-testid="layout-editor">
          <div className="two-col">
            <div className="field">
              <label className="field-label" htmlFor="edit-products">Design / product names</label>
              <textarea id="edit-products" className="input textarea" rows={2} value={products} onChange={(e) => setProducts(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="edit-groups">Product groups</label>
              <textarea id="edit-groups" className="input textarea" rows={2} value={groups} onChange={(e) => setGroups(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="edit-note">What changed (saved with the revision)</label>
            <input id="edit-note" className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. moved die 12 by +0.5 mm in X" />
          </div>
          <div className="editor-toolbar">
            <span className="micro-label">Coordinates (source mm, {fmt(rows.length)} rows)</span>
            <input className="input" style={{ width: 140 }} type="text" placeholder="Filter by die #" value={filter}
              onChange={(e) => { setFilter(e.target.value); setPage(0) }} aria-label="Filter by die" />
            <button type="button" className="btn btn-sm" onClick={addRow}>Add row</button>
            <span className="cell-muted">Page {page + 1} of {pages}</span>
            <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
            <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>›</button>
          </div>
          <div className="table-scroll table-scroll-tall">
            <table className="editor-grid" data-testid="editor-rows">
              <thead>
                <tr><th>Die</th>{kind === 'spring' && <th>Feature</th>}<th>X (mm)</th><th>Y (mm)</th><th></th></tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <td><input aria-label={`Die of row ${r.id}`} value={r.die} onChange={(e) => setCell(r.id, 'die', e.target.value)} /></td>
                    {kind === 'spring' && <td><input aria-label={`Feature of row ${r.id}`} value={r.spring} onChange={(e) => setCell(r.id, 'spring', e.target.value)} /></td>}
                    <td><input aria-label={`X of row ${r.id}`} value={r.x} onChange={(e) => setCell(r.id, 'x', e.target.value)} /></td>
                    <td><input aria-label={`Y of row ${r.id}`} value={r.y} onChange={(e) => setCell(r.id, 'y', e.target.value)} /></td>
                    <td><button type="button" className="btn btn-sm" onClick={() => removeRow(r.id)} aria-label={`Remove row ${r.id}`}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="editor-toolbar">
            <button type="button" className="btn btn-accent" disabled={busy !== null || (!rowsChanged && !namesChanged)} onClick={() => void saveEdits()} data-testid="save-revision">
              {busy === 'save' ? 'Saving…' : 'Save as new revision'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => setEditing(false)}>Cancel</button>
            <span className="cell-muted">
              {rowsChanged ? 'Coordinates changed; the server validates them like an uploaded file.' : namesChanged ? 'Only names changed; coordinates stay the same.' : 'No changes yet.'}
              {author ? ` Saved as ${author}.` : ' Tip: enter your name in the upload panel so revisions show who made them.'}
            </span>
          </div>
        </div>
      ) : (
        figure && geometry && (
          <>
            <div className="micro-label" style={{ marginBottom: 6 }}>
              Showing revision {geometry.rev}{viewingCurrent ? ' (current — draws the wafer maps)' : ''} · {geometry.kind === 'die' ? `${fmt(geometry.summary.gangs)} dies` : `${fmt(geometry.summary.springs)} features in ${fmt(geometry.summary.gangs)} dies`}
            </div>
            <PlotlyChart data={figure.data} layout={figure.layout} className="plot-wafer" testId="history-map" />
            <div className="chart-note">{geometry.caveat}</div>
          </>
        )
      )}

      {detail && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table data-testid="revisions-table">
            <thead>
              <tr><th>Rev</th><th>Saved</th><th>By</th><th>Change</th><th>Note</th><th>Products</th><th>Groups</th><th></th></tr>
            </thead>
            <tbody>
              {detail.revisions.map((r) => (
                <tr key={r.rev} className={r.rev === rev ? 'row-selected' : undefined}>
                  <td><strong>{r.rev}</strong>{r.current && <span className="cell-muted"> (current)</span>}</td>
                  <td className="cell-muted">{when(r.saved_at)}</td>
                  <td>{r.author || '—'}</td>
                  <td>{r.action ? ACTION_LABEL[r.action] ?? r.action : '—'}{r.restored_from ? ` ${r.restored_from}` : ''}</td>
                  <td>{r.note || '—'}</td>
                  <td>{r.products.join(', ')}</td>
                  <td>{r.product_groups.join(', ') || '—'}</td>
                  <td>
                    <span className="card-actions">
                      <button type="button" className="btn btn-sm" disabled={!r.available || busy !== null} onClick={() => { setEditing(false); setRev(r.rev) }} data-testid={`view-rev-${r.rev}`}>View</button>
                      {!r.current && (
                        <button type="button" className="btn btn-sm" disabled={!r.available || busy !== null} onClick={() => void restore(r.rev)} data-testid={`restore-rev-${r.rev}`}>Restore</button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="chart-note">Restoring adds a new revision that copies the old one, so the history is never rewritten. The current (latest) revision draws every wafer map.</div>
        </div>
      )}
    </section>
  )
}
