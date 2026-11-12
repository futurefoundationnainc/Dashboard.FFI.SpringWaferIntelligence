import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { LayoutPreview } from '../api/types'
import { readAuthor, rememberAuthor } from '../authorName'
import { CoordinatesPanel } from '../components/editor/CoordinatesPanel'
import { EditorToolbar } from '../components/editor/EditorToolbar'
import { LayoutCanvas } from '../components/editor/LayoutCanvas'
import { LayoutDetailsPanel } from '../components/editor/LayoutDetailsPanel'
import { LayoutList } from '../components/editor/LayoutList'
import { UploadPanel } from '../components/editor/UploadPanel'
import { rowsFromGeometry, rowsToDrawable, type DrawableLayout, type EditRow } from '../components/editor/coordinateRows'
import { useElementSize } from '../hooks/useElementSize'
import { useLayoutEditor } from '../hooks/useLayoutEditor'
import { hashParams, safeReturn } from '../router'
import type { ChartColors } from '../theme/chartColors'
import type { Theme } from '../theme/useTheme'

interface Props {
  colors: ChartColors
  theme: Theme
  onToggleTheme: () => void
}

type Mode = 'view' | 'new' | 'revision' | 'coords'

const MIN_MAP = 280

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* The standalone Layout Editor (#/editor): layouts on the left, the layout
   drawn as large as the screen allows in the middle, its details / upload /
   coordinate editing on the right. Opened from a wafer map it knows the
   wafer's product and group: it selects the matching layout, or starts a new
   one for it when there is none, and offers the way back. */
export function LayoutEditorPage({ colors, theme, onToggleTheme }: Props) {
  const [context] = useState(() => {
    const p = hashParams()
    return { product: p.get('product') ?? '', group: p.get('group') ?? '', returnTo: safeReturn(p.get('return')) }
  })
  const backToWafer = context.returnTo ? `${window.location.pathname}${context.returnTo}` : null
  const [author, setAuthor] = useState(readAuthor)
  const onAuthor = (v: string) => { setAuthor(v); rememberAuthor(v) }
  const ed = useLayoutEditor(author)

  const [mode, setMode] = useState<Mode>('view')
  const [upload, setUpload] = useState<{ file: File; preview: LayoutPreview } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [rows, setRows] = useState<EditRow[]>([])
  const [rowsChanged, setRowsChanged] = useState(false)
  const lastGood = useRef<DrawableLayout | null>(null)

  // Opened for a wafer: select its layout, or start a new one when none matches.
  const autoPicked = useRef(false)
  useEffect(() => {
    if (autoPicked.current || !ed.loaded) return
    autoPicked.current = true
    if (!context.product && !context.group) return
    const visible = ed.layouts.filter((l) => !l.hidden)
    const hit = visible.find((l) => l.products.includes(context.product)) ?? visible.find((l) => context.group && (l.product_groups ?? []).includes(context.group))
    if (hit) ed.select(hit.name)
    else setMode('new')
  }, [ed, context])

  const leaveMode = useCallback(() => {
    setMode('view')
    setUpload(null)
    setPreviewError(null)
    setRowsChanged(false)
  }, [])

  const pick = useCallback(async (file: File | null) => {
    setUpload(null)
    setPreviewError(null)
    if (!file) return
    try {
      setUpload({ file, preview: await api.previewLayout(file) })
    } catch (err) {
      setPreviewError(errorText(err))
    }
  }, [])

  const startCoords = () => {
    if (!ed.geometry) return
    setRows(rowsFromGeometry(ed.geometry))
    setRowsChanged(false)
    setMode('coords')
  }

  // What the map draws: the file being uploaded, the rows being edited, or the revision being viewed.
  const drawable = useMemo<DrawableLayout | null>(() => {
    if (mode === 'new' || mode === 'revision') return upload?.preview ?? null
    if (mode === 'coords' && ed.geometry) {
      const live = rowsToDrawable(rows, ed.geometry.kind, ed.geometry.pitch)
      if (live) lastGood.current = live
      return live ?? lastGood.current
    }
    return mode === 'view' ? ed.geometry : null
  }, [mode, upload, rows, ed.geometry])

  const [mapHost, space] = useElementSize<HTMLDivElement>()
  const side = space ? Math.max(MIN_MAP, Math.floor(Math.min(space.width, space.height))) : 560

  const caption = mode === 'new' || mode === 'revision'
    ? (upload ? `Preview of ${upload.file.name} · not saved` : 'Choose a coordinate file to preview it here.')
    : mode === 'coords'
      ? `Editing ${ed.detail?.name ?? ''} · ${rowsChanged ? 'unsaved changes' : 'no changes yet'}`
      : ed.detail && ed.viewRev
        ? `${ed.detail.name} · revision ${ed.viewRev}${ed.viewRev === ed.detail.revision ? ' (current, draws the wafer maps)' : ' (older revision)'}`
        : ''
  const emptyText = mode === 'new' || mode === 'revision'
    ? 'Choose a coordinate file to see it here before saving.'
    : ed.layouts.length === 0 && ed.loaded ? 'No layouts yet. Start with + New layout.' : 'Choose a layout on the left.'

  const nextRevision = (ed.detail?.revision ?? 0) + 1

  return (
    <main className="editor-page">
      <EditorToolbar backToWafer={backToWafer} author={author} onAuthor={onAuthor} theme={theme} onToggleTheme={onToggleTheme} />
      {(context.product || context.group) && (
        <div className="warning-banner" role="note" data-testid="editor-context">
          <div>
            Opened for a wafer of product <strong>{context.product || '—'}</strong>{context.group && <> (group <strong>{context.group}</strong>)</>}.
            {' '}Select the layout that fits and add this product or group to it, or create a new layout for it.
          </div>
        </div>
      )}
      {ed.error && <div className="error-banner" role="alert" data-testid="editor-error">{ed.error}</div>}
      {ed.message && <div className="warning-banner" role="status" style={{ borderLeftColor: 'var(--good)' }} data-testid="editor-message">✓ {ed.message}</div>}

      <div className="editor-stage">
        <LayoutList
          layouts={ed.layouts}
          selected={ed.selected}
          onSelect={(name) => { leaveMode(); ed.select(name) }}
          onNew={() => { leaveMode(); setMode('new') }}
          product={context.product}
          group={context.group}
        />

        <section className="card editor-map-card">
          <div className="map-pair-host" ref={mapHost}>
            <div className="map-pair">
              <LayoutCanvas layout={drawable} colors={colors} size={side} emptyText={emptyText} />
            </div>
          </div>
          <div className="chart-note one-line" data-testid="editor-caption">{caption}</div>
        </section>

        <div className="editor-side">
          {mode === 'new' && (
            <UploadPanel
              mode="new"
              preview={upload?.preview ?? null}
              previewError={previewError}
              busy={ed.busy}
              product={context.product}
              group={context.group}
              onPick={(f) => void pick(f)}
              onSave={async (fields) => { if (upload && await ed.createLayout(upload.file, fields)) leaveMode() }}
              onCancel={leaveMode}
            />
          )}
          {mode === 'revision' && ed.detail && (
            <UploadPanel
              mode="revision"
              layoutName={ed.detail.name}
              nextRevision={nextRevision}
              preview={upload?.preview ?? null}
              previewError={previewError}
              busy={ed.busy}
              product=""
              group=""
              onPick={(f) => void pick(f)}
              onSave={async ({ note }) => { if (upload && await ed.uploadRevision(upload.file, note)) leaveMode() }}
              onCancel={leaveMode}
            />
          )}
          {mode === 'coords' && ed.detail && ed.geometry && (
            <CoordinatesPanel
              layoutName={ed.detail.name}
              nextRevision={nextRevision}
              kind={ed.geometry.kind}
              rows={rows}
              changed={rowsChanged}
              busy={ed.busy}
              onRowsChange={(next) => { setRows(next); setRowsChanged(true) }}
              onSave={async (note) => { if (ed.geometry && await ed.saveCoordinates(rows, ed.geometry.kind, note)) leaveMode() }}
              onCancel={leaveMode}
            />
          )}
          {mode === 'view' && ed.detail && (
            <LayoutDetailsPanel
              detail={ed.detail}
              geometry={ed.geometry}
              viewRev={ed.viewRev}
              busy={ed.busy}
              product={context.product}
              group={context.group}
              onViewRev={ed.setViewRev}
              onRestore={(rev) => void ed.restore(rev)}
              onSaveNames={(p, g, note) => void ed.saveNames(p, g, note)}
              onHidden={(h) => void ed.setHidden(h)}
              onUploadRevision={() => { leaveMode(); setMode('revision') }}
              onEditCoordinates={startCoords}
            />
          )}
          {mode === 'view' && !ed.detail && (
            <section className="card">
              <div className="micro-label">Layout Editor</div>
              <p className="chart-note">
                A layout gives every die (and, on 2D wafers, every feature) its position on the wafer. Wafer maps are drawn from the
                newest revision of the layout that names the wafer&apos;s product, or else its product group. Choose a layout to see
                and change it, or start a new one.
              </p>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
