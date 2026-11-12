import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LayoutDetail, LayoutGeometry, LayoutItem, LayoutPreview } from '../api/types'
import App from '../App'
import { rowsFromGeometry, rowsProblem, rowsToCsv, rowsToDrawable } from '../components/editor/coordinateRows'
import { reactCalls } from '../test/plotlyStub'
import { installFetchStub } from './helpers'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const SUMMARY = {
  springs: 4, gangs: 4, springs_per_gang_min: 1, springs_per_gang_max: 1, center_x: 5, center_y: 0, x_min: 0, x_max: 10,
  y_min: 0, y_max: 0, max_radius_mm: 5, kind: 'die' as const, units: 'mm' as const, pitch_x_mm: 10, pitch_y_mm: 10, warnings: [],
}

function item(over: Partial<LayoutItem> = {}): LayoutItem {
  return {
    name: 'SEQ', file: 'SEQ.r002.csv', products: ['X-1'], product_groups: [], implicit: false, hidden: false, saved_at: '2026-11-12T10:00:00+00:00',
    source_filename: 'seq.csv', revision: 2, revision_count: 2, author: 'bob', note: '', size_bytes: 10, summary: SUMMARY, error: null, ...over,
  }
}

function detail(over: Partial<LayoutDetail> = {}): LayoutDetail {
  return {
    ...item(),
    revisions: [
      { rev: 2, file: 'SEQ.r002.csv', saved_at: '2026-11-12T10:00:00+00:00', author: 'bob', note: 'moved', source_filename: 'seq.csv', action: 'edit', restored_from: null, products: ['X-1'], product_groups: [], current: true, available: true },
      { rev: 1, file: 'SEQ.csv', saved_at: '2026-11-11T10:00:00+00:00', author: 'ann', note: '', source_filename: 'seq.csv', action: 'upload', restored_from: null, products: ['X-1'], product_groups: [], current: false, available: true },
    ],
    ...over,
  }
}

function geometry(rev: number): LayoutGeometry {
  return {
    name: 'SEQ', rev, kind: 'die', pitch: { x: 10, y: 10 }, die: [1, 2, 3, 4], spring: [1, 1, 1, 1], x: [-5, 5, -5, 5], y: [-5, -5, 5, 5],
    source_x: [0, 10, 0, 10], source_y: [0, 0, 10, 10], gangs: [1, 2, 3, 4].map((die) => ({ die, xmin: 0, xmax: 0, ymin: 0, ymax: 0 })),
    summary: SUMMARY, caveat: 'Notch down assumed.',
  }
}

function setUrl(hash: string) {
  window.history.replaceState(null, '', `/${hash}`)
}

afterEach(() => {
  setUrl('')
  vi.unstubAllGlobals()
})

describe('coordinate rows', () => {
  const rows = rowsFromGeometry(geometry(1))
  it('round-trips rows, validates them and centers them like the server', () => {
    expect(rowsToCsv(rows, 'die')).toBe('Die_Num,X,Y\n1,0,0\n2,10,0\n3,0,10\n4,10,10\n')
    expect(rowsProblem(rows, 'die')).toBeNull()
    expect(rowsProblem([...rows, { ...rows[0], id: 9 }], 'die')).toBe('Die 1 appears twice.')
    expect(rowsProblem([{ ...rows[0], x: 'abc' }], 'die')).toMatch(/must be numbers/)
    const d = rowsToDrawable(rows, 'die', { x: 10, y: 10 })
    expect(d?.x).toEqual([-5, 5, -5, 5]) // centered on the bounding-box midpoint
    const um = rowsToDrawable(rows.map((r) => ({ ...r, x: String(Number(r.x) * 1000), y: String(Number(r.y) * 1000) })), 'die', null)
    expect(um?.x).toEqual([-5, 5, -5, 5]) // values beyond 1,000 read as micrometres
    expect(rowsToDrawable([{ ...rows[0], die: 'x' }], 'die', null)).toBeNull()
  })
})

describe('Layout Editor page', () => {
  it('opens for a wafer, selects its layout by group, and adds the product as a new revision', async () => {
    setUrl('?sample=W1.1&plan=3d#/editor?product=159-501160A&group=SEQUOIA+I&return=%3Fsample%3DW1.1%26plan%3D3d')
    const { calls } = installFetchStub({
      '/api/layouts': () => json({ layouts: [item({ product_groups: ['SEQUOIA I'] }), item({ name: 'OTHER', products: ['Y-1'] })] }),
      '/api/layouts/SEQ': () => json(detail({ product_groups: ['SEQUOIA I'] })),
      '/api/layouts/SEQ/revisions/2': () => json(geometry(2)),
      '/api/layouts/SEQ/revisions/1': () => json(geometry(1)),
      '/api/layouts/SEQ/names': () => json(item({ revision: 3, products: ['X-1', '159-501160A'], product_groups: ['SEQUOIA I'] })),
    })
    render(<App />)
    expect(await screen.findByTestId('layout-title')).toHaveTextContent('SEQ') // picked via its group
    expect(await screen.findByTestId('editor-map')).toBeInTheDocument()
    expect(screen.getByText('this wafer')).toBeInTheDocument()
    expect(screen.getByTestId('back-to-wafer')).toHaveAttribute('href', '/?sample=W1.1&plan=3d')
    expect(screen.queryByText('Wafer Defect Map Intelligence')).not.toBeInTheDocument() // standalone page, no prototype header

    await userEvent.click(screen.getByRole('button', { name: '+ Add product 159-501160A' }))
    await userEvent.type(screen.getByLabelText('Your name'), 'ann')
    await userEvent.click(screen.getByTestId('save-names'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/layouts/SEQ/names')).toBe(true))
    expect(calls.find((c) => c.url === '/api/layouts/SEQ/names')?.body).toMatchObject({ products: ['X-1', '159-501160A'], product_groups: ['SEQUOIA I'], author: 'ann' })
    expect(await screen.findByTestId('editor-message')).toHaveTextContent('Saved revision 3')

    await userEvent.click(screen.getByTestId('view-rev-1'))
    await waitFor(() => expect(screen.getByTestId('editor-caption')).toHaveTextContent('revision 1 (older revision)'))
  })

  it('previews an uploaded file on the map before saving it as a new revision', async () => {
    setUrl('#/editor')
    const preview: LayoutPreview = { filename: 'v3.csv', suggested_name: 'v3', summary: SUMMARY, kind: 'die', pitch: { x: 10, y: 10 }, die: [1], spring: [1], x: [0], y: [0], gangs: [{ die: 1, xmin: 0, xmax: 0, ymin: 0, ymax: 0 }], caveat: '' }
    const { calls } = installFetchStub({
      '/api/layouts': (init) => (init?.method === 'POST' ? json(item({ revision: 3 })) : json({ layouts: [item()] })),
      '/api/layouts/preview': () => json(preview),
      '/api/layouts/SEQ': () => json(detail()),
      '/api/layouts/SEQ/revisions/2': () => json(geometry(2)),
    })
    render(<App />)
    await userEvent.click(within(await screen.findByTestId('layout-list')).getByText('SEQ'))
    await userEvent.click(await screen.findByTestId('upload-revision'))
    await userEvent.upload(screen.getByLabelText(/Coordinate file/), new File(['x'], 'v3.csv', { type: 'text/csv' }))
    expect(await screen.findByTestId('preview-facts')).toHaveTextContent('v3.csv')
    expect(screen.getByTestId('editor-caption')).toHaveTextContent('Preview of v3.csv · not saved')
    await waitFor(() => expect((reactCalls[reactCalls.length - 1].layout.shapes as unknown[]).length).toBe(1)) // the map shows the file
    await userEvent.click(screen.getByTestId('save-upload'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/layouts' && c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.url === '/api/layouts' && c.method === 'POST')?.body).toMatchObject({ name: 'SEQ', replace: 'true', action: 'upload', file: 'v3.csv' })
  })

  it('edits coordinates with a live map and saves them as a revision; hides a layout', async () => {
    setUrl('#/editor')
    const { calls } = installFetchStub({
      '/api/layouts': (init) => (init?.method === 'POST' ? json(item({ revision: 3 })) : json({ layouts: [item()] })),
      '/api/layouts/SEQ': () => json(detail()),
      '/api/layouts/SEQ/revisions/2': () => json(geometry(2)),
      '/api/layouts/SEQ/hidden': () => json(item({ hidden: true })),
    })
    render(<App />)
    await userEvent.click(within(await screen.findByTestId('layout-list')).getByText('SEQ'))
    await waitFor(() => expect(screen.getByTestId('edit-coordinates')).not.toBeDisabled())
    await userEvent.click(screen.getByTestId('edit-coordinates'))
    const x = await screen.findByLabelText('X of row 1')
    await userEvent.clear(x)
    await userEvent.type(x, '30')
    // the map redraws: die 2 moved right, so the centered x of die 1 changes from -5 to -15
    await waitFor(() => {
      const hover = reactCalls[reactCalls.length - 1].data.find((t) => t.name === 'Dies') as { x: number[] }
      expect(hover.x[0]).toBe(-15)
    })
    await userEvent.click(screen.getByTestId('save-coordinates'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/layouts')).toBe(true))
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/layouts')?.body).toMatchObject({ action: 'edit', replace: 'true', file: 'SEQ-edited.csv' })

    await userEvent.click(await screen.findByTestId('toggle-hidden'))
    await waitFor(() => expect(calls.find((c) => c.url === '/api/layouts/SEQ/hidden')?.body).toMatchObject({ hidden: true }))
  })
})
