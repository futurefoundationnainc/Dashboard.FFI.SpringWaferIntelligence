import { useState } from 'react'
import type { LayoutPreview } from '../../api/types'
import { fmt } from '../../format'

interface Props {
  /* 'new': a new layout (name, products, groups). 'revision': the next revision of `layoutName`. */
  mode: 'new' | 'revision'
  layoutName?: string
  nextRevision?: number
  preview: LayoutPreview | null
  previewError: string | null
  busy: boolean
  /* Prefill from the wafer the editor was opened for. */
  product: string
  group: string
  onPick: (file: File | null) => void
  onSave: (fields: { name: string; products: string; groups: string; note: string }) => void
  onCancel: () => void
}

/* Upload a coordinate file: it is parsed and drawn on the map before anything
   is saved; then save it as a new layout or as the next revision of one. */
export function UploadPanel({ mode, layoutName, nextRevision, preview, previewError, busy, product, group, onPick, onSave, onCancel }: Props) {
  const [name, setName] = useState(product)
  const [products, setProducts] = useState(product)
  const [groups, setGroups] = useState(group)
  const [note, setNote] = useState('')
  const s = preview?.summary

  return (
    <div className="editor-panel" data-testid="upload-panel">
      <section className="card">
        <div className="micro-label">{mode === 'new' ? 'New layout' : `New revision of ${layoutName}`}</div>
        <div className="field file-field">
          <label className="field-label" htmlFor="ed-file">Coordinate file (CSV or XLSX)</label>
          <input id="ed-file" type="file" accept=".csv,.xlsx" disabled={busy} onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
          <div className="file-name">
            Feature layout: Die_Num, Spring_Num (the feature number), X, Y — one row per feature. Die layout: Die #, X, Y — one row per die.
            mm or µm (detected); header notes in parentheses are fine.
          </div>
        </div>
        {previewError && <div className="error-banner" role="alert" data-testid="preview-error">Could not read the file: {previewError}</div>}
        {s && (
          <>
            <dl className="facts" data-testid="preview-facts">
              <dt>File</dt><dd className="break">{preview?.filename}</dd>
              <dt>Kind</dt><dd>{s.kind === 'die' ? 'Die map (no feature level)' : 'Feature map'}</dd>
              {s.kind === 'die' ? (<><dt>Dies</dt><dd>{fmt(s.gangs)}</dd></>) : (<><dt>Features</dt><dd>{fmt(s.springs)} in {fmt(s.gangs)} dies</dd></>)}
              <dt>Units</dt><dd>{s.units === 'um->mm' ? 'µm, converted to mm' : 'mm'}</dd>
              <dt>Max radius</dt><dd className={s.max_radius_mm > 100 ? 'status-alarm' : undefined}>{fmt(s.max_radius_mm, 1)} mm</dd>
            </dl>
            {s.warnings.length > 0 && <div className="warning-banner" role="note">{s.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>}
            <div className="chart-note">The map shows this file. Nothing is saved yet.</div>
          </>
        )}
      </section>

      <section className="card">
        {mode === 'new' && (
          <>
            <div className="field">
              <label className="field-label" htmlFor="ed-name">Layout name</label>
              <input id="ed-name" className="input" type="text" value={name} placeholder="e.g. 159-501160A" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="ed-new-products">Products (PRODUCT)</label>
              <textarea id="ed-new-products" className="input textarea" rows={2} value={products} onChange={(e) => setProducts(e.target.value)} placeholder="One per line or comma-separated" />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="ed-new-groups">Product groups (optional)</label>
              <textarea id="ed-new-groups" className="input textarea" rows={2} value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="e.g. SEQUOIA I" />
            </div>
          </>
        )}
        <div className="field">
          <label className="field-label" htmlFor="ed-upload-note">Note (optional)</label>
          <input id="ed-upload-note" className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this layout / revision is" />
        </div>
        <div className="editor-toolbar">
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || !preview || (mode === 'new' && !name.trim())}
            onClick={() => onSave({ name: name.trim(), products, groups, note: note.trim() })}
            data-testid="save-upload"
          >
            {mode === 'new' ? 'Save layout' : `Save as revision ${nextRevision ?? ''}`}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  )
}
