import { useEffect, useState } from 'react'
import type { LayoutDetail, LayoutGeometry } from '../../api/types'
import { fmt } from '../../format'

interface Props {
  detail: LayoutDetail
  /* Geometry of the revision on the map (for its numbers and warnings). */
  geometry: LayoutGeometry | null
  viewRev: number | null
  busy: boolean
  product: string
  group: string
  onViewRev: (rev: number) => void
  onRestore: (rev: number) => void
  onSaveNames: (products: string[], groups: string[], note: string) => void
  onHidden: (hidden: boolean) => void
  onUploadRevision: () => void
  onEditCoordinates: () => void
}

const ACTION_LABEL: Record<string, string> = { upload: 'Uploaded file', edit: 'Edited coordinates', restore: 'Restored', names: 'Changed names' }

function splitNames(value: string): string[] {
  return value.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean)
}

function when(value: string | null): string {
  if (!value) return 'pre-existing file'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

/* One layout: its numbers, the products / groups it serves (editable), its
   revision history (view any, restore any) and its actions. Every change is a
   new revision; nothing is overwritten or deleted. */
export function LayoutDetailsPanel({
  detail, geometry, viewRev, busy, product, group, onViewRev, onRestore, onSaveNames, onHidden, onUploadRevision, onEditCoordinates,
}: Props) {
  const [products, setProducts] = useState(detail.products.join(', '))
  const [groups, setGroups] = useState((detail.product_groups ?? []).join(', '))
  const [note, setNote] = useState('')
  useEffect(() => {
    setProducts(detail.products.join(', '))
    setGroups((detail.product_groups ?? []).join(', '))
    setNote('')
  }, [detail])

  const s = geometry?.summary ?? detail.summary
  const current = detail.revision ?? 1
  const namesChanged = splitNames(products).join('|') !== detail.products.join('|') || splitNames(groups).join('|') !== (detail.product_groups ?? []).join('|')
  const canAddProduct = Boolean(product) && !splitNames(products).includes(product)
  const canAddGroup = Boolean(group) && !splitNames(groups).includes(group)

  return (
    <div className="editor-panel" data-testid="layout-details">
      <section className="card">
        <div className="micro-label">Layout{detail.hidden ? ' · hidden' : ''}</div>
        <h2 className="card-title wafer-id" data-testid="layout-title">{detail.name}</h2>
        {s && (
          <dl className="facts">
            <dt>Kind</dt><dd>{s.kind === 'die' ? 'Die map (no feature level)' : 'Feature map'}</dd>
            {s.kind === 'die' ? (
              <>
                <dt>Dies</dt><dd>{fmt(s.gangs)}</dd>
                <dt>Grid pitch</dt><dd>{s.pitch_x_mm !== null && s.pitch_y_mm !== null ? `${fmt(s.pitch_x_mm, 2)} × ${fmt(s.pitch_y_mm, 2)} mm` : '—'}</dd>
              </>
            ) : (
              <>
                <dt>Features</dt><dd>{fmt(s.springs)}</dd>
                <dt>Dies</dt><dd>{fmt(s.gangs)}</dd>
                <dt>Features / die</dt><dd>{s.springs_per_gang_min === s.springs_per_gang_max ? fmt(s.springs_per_gang_min) : `${fmt(s.springs_per_gang_min)}–${fmt(s.springs_per_gang_max)}`}</dd>
              </>
            )}
            <dt>Units</dt><dd>{s.units === 'um->mm' ? 'µm, converted to mm' : 'mm'}</dd>
            <dt>Center</dt><dd>{fmt(s.center_x, 3)}, {fmt(s.center_y, 3)} mm</dd>
            <dt>Max radius</dt><dd className={s.max_radius_mm > 100 ? 'status-alarm' : undefined}>{fmt(s.max_radius_mm, 1)} mm</dd>
            <dt>Revision</dt><dd>{current}{detail.author ? ` · by ${detail.author}` : ''}</dd>
          </dl>
        )}
        {s && s.warnings.length > 0 && (
          <div className="warning-banner" role="note" data-testid="layout-warnings">{s.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>
        )}
        <div className="editor-toolbar">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onUploadRevision} data-testid="upload-revision">Upload new revision</button>
          <button type="button" className="btn btn-sm" disabled={busy || !geometry} onClick={onEditCoordinates} data-testid="edit-coordinates">Edit coordinates</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onHidden(!detail.hidden)} data-testid="toggle-hidden">
            {detail.hidden ? 'Bring back' : 'Hide'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="micro-label">Draws wafers of</div>
        <div className="field">
          <label className="field-label" htmlFor="ed-products">Products (PRODUCT)</label>
          <textarea id="ed-products" className="input textarea" rows={2} value={products} onChange={(e) => setProducts(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="ed-groups">Product groups (PRODUCTGROUP, used when no layout names the product)</label>
          <textarea id="ed-groups" className="input textarea" rows={2} value={groups} onChange={(e) => setGroups(e.target.value)} />
        </div>
        {(canAddProduct || canAddGroup) && (
          <div className="editor-toolbar" data-testid="add-context">
            {canAddProduct && <button type="button" className="btn btn-sm" onClick={() => setProducts([...splitNames(products), product].join(', '))}>+ Add product {product}</button>}
            {canAddGroup && <button type="button" className="btn btn-sm" onClick={() => setGroups([...splitNames(groups), group].join(', '))}>+ Add group {group}</button>}
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor="ed-names-note">Note (optional)</label>
          <input id="ed-names-note" className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button type="button" className="btn btn-sm btn-accent" disabled={busy || !namesChanged} onClick={() => onSaveNames(splitNames(products), splitNames(groups), note)} data-testid="save-names">
          Save as revision {current + 1}
        </button>
      </section>

      <section className="card">
        <div className="micro-label">Revisions</div>
        <table data-testid="revisions-table">
          <thead><tr><th>Rev</th><th>Saved</th><th>By</th><th>Change</th><th></th></tr></thead>
          <tbody>
            {detail.revisions.map((r) => (
              <tr key={r.rev} className={r.rev === viewRev ? 'row-selected' : undefined} title={r.note ?? undefined}>
                <td><strong>{r.rev}</strong>{r.current && <span className="cell-muted"> (current)</span>}</td>
                <td className="cell-muted">{when(r.saved_at)}</td>
                <td>{r.author || '—'}</td>
                <td>{r.action ? ACTION_LABEL[r.action] ?? r.action : '—'}{r.restored_from ? ` ${r.restored_from}` : ''}{r.note ? <span className="cell-muted"> · {r.note}</span> : null}</td>
                <td>
                  <span className="card-actions">
                    <button type="button" className="btn btn-sm" disabled={!r.available || r.rev === viewRev} onClick={() => onViewRev(r.rev)} data-testid={`view-rev-${r.rev}`}>View</button>
                    {!r.current && <button type="button" className="btn btn-sm" disabled={busy || !r.available} onClick={() => onRestore(r.rev)} data-testid={`restore-rev-${r.rev}`}>Restore</button>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="chart-note">Restoring adds a new revision that copies the old one. The newest revision draws every wafer map.</div>
      </section>
    </div>
  )
}
