import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { LayoutDetail, LayoutGeometry, LayoutItem, LayoutKind } from '../api/types'
import { rowsToCsv, type EditRow } from '../components/editor/coordinateRows'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface NewLayoutFields {
  name: string
  products: string
  groups: string
  note: string
}

/* Everything the Layout Editor reads and writes, so the page only renders.
   Every write creates a revision (or a layout) and then reloads what changed. */
export function useLayoutEditor(author: string) {
  const [layouts, setLayouts] = useState<LayoutItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<LayoutDetail | null>(null)
  const [viewRev, setViewRev] = useState<number | null>(null)
  const [geometry, setGeometry] = useState<LayoutGeometry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLayouts((await api.layouts()).layouts)
    } catch (err) {
      setError(`Could not load layouts: ${errorText(err)}`)
    } finally {
      setLoaded(true)
    }
  }, [])

  const loadDetail = useCallback(async (name: string, rev?: number) => {
    const d = await api.layout(name)
    setDetail(d)
    setViewRev(rev ?? d.revision ?? 1)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setGeometry(null)
      setViewRev(null)
      return
    }
    loadDetail(selected).catch((err) => setError(errorText(err)))
  }, [selected, loadDetail])

  useEffect(() => {
    if (!selected || viewRev === null) return
    let cancelled = false
    api.layoutRevision(selected, viewRev)
      .then((g) => { if (!cancelled) setGeometry(g) })
      .catch((err) => { if (!cancelled) { setGeometry(null); setError(errorText(err)) } })
    return () => { cancelled = true }
  }, [selected, viewRev])

  const run = useCallback(async (action: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      setMessage(await action())
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const afterSave = useCallback(async (name: string, rev?: number) => {
    await refresh()
    if (name !== selected) setSelected(name)
    else await loadDetail(name, rev)
  }, [refresh, loadDetail, selected])

  const who = author.trim()

  return {
    layouts, loaded, selected, select: setSelected, detail, viewRev, setViewRev, geometry, busy, error, message, setError, setMessage,

    saveNames: (products: string[], groups: string[], note: string) => run(async () => {
      const item = await api.updateLayoutNames(selected as string, products, groups, who, note)
      await afterSave(item.name, item.revision)
      return `Saved revision ${item.revision}: products and groups updated.`
    }),

    restore: (rev: number) => run(async () => {
      const item = await api.restoreLayout(selected as string, rev, who)
      await afterSave(item.name, item.revision)
      return `Revision ${rev} restored as revision ${item.revision}.`
    }),

    setHidden: (hidden: boolean) => run(async () => {
      const item = await api.setLayoutHidden(selected as string, hidden, who)
      await afterSave(item.name)
      return hidden ? `${item.name} is hidden: it no longer draws wafer maps. "Show hidden" + Bring back restores it.` : `${item.name} is back.`
    }),

    createLayout: (file: File, f: NewLayoutFields) => run(async () => {
      const item = await api.saveLayout({ name: f.name, products: f.products, productGroups: f.groups, replace: false, file, author: who, note: f.note, action: 'upload' })
      await afterSave(item.name, item.revision)
      return `Saved layout ${item.name}. Wafers of ${[...item.products, ...(item.product_groups ?? []).map((g) => `group ${g}`)].join(', ')} now draw with it.`
    }),

    uploadRevision: (file: File, note: string) => run(async () => {
      const d = detail as LayoutDetail
      const item = await api.saveLayout({
        name: d.name, products: d.products.join(', '), productGroups: (d.product_groups ?? []).join(', '), replace: true, file, author: who, note, action: 'upload',
      })
      await afterSave(item.name, item.revision)
      return `Saved revision ${item.revision} of ${item.name}.`
    }),

    saveCoordinates: (rows: EditRow[], kind: LayoutKind, note: string) => run(async () => {
      const d = detail as LayoutDetail
      const file = new File([rowsToCsv(rows, kind)], `${d.name}-edited.csv`, { type: 'text/csv' })
      const item = await api.saveLayout({
        name: d.name, products: d.products.join(', '), productGroups: (d.product_groups ?? []).join(', '), replace: true, file, author: who, note, action: 'edit',
      })
      await afterSave(item.name, item.revision)
      return `Saved revision ${item.revision}: coordinates edited.`
    }),
  }
}
