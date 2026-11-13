import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiBase } from '../api/client'
import type { FilterDefinition, FilterRule, LayoutDetail, LayoutGeometry, SavedMapFilter, WaferMap } from '../api/types'
import { countsWithin, definitionMatches, describeDefinition, filterMask, ruleMatches, ruleProblem, stageNumber } from '../components/wafer/mapFilter'
import App from '../App'
import { rowsToCsv } from '../pages/LayoutHistory'
import { readWaferQuery } from '../pages/WaferMapPage'
import { CARD_PAD_X, LEGEND_WIDTH, PAIR_GAP, SIDEBAR_MIN, STAGE_GAP, pairLayout } from '../components/wafer/mapGeometry'
import { buildIndividualFigure, buildLayoutFigure } from '../charts/waferFigures'
import { buildMask, stageKey, stageLabels, stageShown, toggleCode, toggleStage } from '../components/wafer/statusFilter'
import { resolveChartColors } from '../theme/chartColors'
import { makeReference } from './helpers'
import { hashParams, layoutEditorHash, routeFromHash, safeReturn } from '../router'
import { reactCalls } from '../test/plotlyStub'
import { installFetchStub } from './helpers'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function makeWaferMap(overrides: Partial<WaferMap> = {}): WaferMap {
  return {
    sample_id: 'W305463.5',
    plan: '3d',
    status: 'ok',
    message: null,
    file: {
      plan: '3d', plan_label: '3D (3D_YIELD_MONITOR)', collection_plan: '3D_YIELD_MONITOR', folder: 'risa/2026/2026_10_31', timestamp: '2026-10-31 22:01:56',
      filename: 'iXML#1817_3D_YIELD_MONITOR_2026_10_31_T_22_01_56_156_MsgId_MET_W3054635_2026_31_10T22_00_28770Z.xml',
      candidates_in_folder: 1, folders_scanned: 13,
    },
    source: { source: 'local', location: 'local folder, /risa/yyyy/yyyy_MM_dd/', lookback_days: 365 },
    product: '159-501160A',
    product_group: 'SEQUOIA I',
    level: 'die',
    transaction_id: 'MET_W305463.5_2026-31-10T22:00:28.770Z',
    farm_dies: [1],
    summary: { unit: 'die', total: 3, good: 2, bad: 1, yield_pct: 66.666, farm_dies: 1, farm_good: 1, dies: 4 },
    status_counts: [{ status: 'Good', count: 3 }, { status: 'UD', count: 1 }],
    states: ['Good', 'UD', 'Uninspected'],
    colors: { Good: '#21a653', UD: '#df3537', Uninspected: '#aab4c2' },
    layout: { name: 'SEQUOIA-I', revision: 2, matched_by: 'product_group', kind: 'die' },
    map: {
      kind: 'die', pitch: { x: 10, y: 10 }, die: [1, 2, 3, 4], spring: [1, 1, 1, 1], x: [-10, 0, 10, 0], y: [0, 0, 0, 10],
      gangs: [1, 2, 3, 4].map((die) => ({ die, xmin: 0, xmax: 0, ymin: 0, ymax: 0 })), center: { x: 5, y: 5 },
      status_codes: [0, 0, 1, 0], uninspected: 0, die_yield: null,
      caveat: 'Coordinate center inferred from extents: X=5.000, Y=5.000 mm. Notch down assumed.',
    },
    caveat: 'Exploratory view of one inspection export.',
    ...overrides,
  }
}

function setUrl(search: string, hash = '') {
  window.history.replaceState(null, '', `/${search}${hash}`)
}

afterEach(() => {
  setUrl('', '')
  vi.unstubAllGlobals()
})

describe('map sizing', () => {
  it('sizes the map square to the height and makes the map card hug map + list', () => {
    // wide screen: height-bound; the details column gets everything else
    const wide = pairLayout({ stageWidth: 1900, hostWidth: 1200, hostHeight: 820, stacked: false })
    expect(wide).toEqual({ side: 820, mapColumn: 820 + PAIR_GAP + LEGEND_WIDTH + CARD_PAD_X })
    expect(1900 - (wide.mapColumn as number) - STAGE_GAP).toBeGreaterThan(SIDEBAR_MIN)
    // narrower: width-bound so the details keep their minimum width
    const mid = pairLayout({ stageWidth: 1100, hostWidth: 700, hostHeight: 820, stacked: false })
    expect(mid.side).toBe(1100 - SIDEBAR_MIN - STAGE_GAP - CARD_PAD_X - LEGEND_WIDTH - PAIR_GAP)
    // stacked (details below): use the card's own width, full-width column
    expect(pairLayout({ stageWidth: 900, hostWidth: 880, hostHeight: 600, stacked: true })).toEqual({ side: 600, mapColumn: null })
    expect(pairLayout({ stageWidth: 300, hostWidth: 100, hostHeight: 200, stacked: false }).side).toBe(280)
    expect(pairLayout({ stageWidth: null, hostWidth: null, hostHeight: null, stacked: false })).toEqual({ side: 640, mapColumn: null })
  })
})

describe('status filter on the spring map', () => {
  it('draws only the selected statuses and hovers only what is drawn', () => {
    const colors = resolveChartColors('dark')
    const ref = makeReference()
    const codes = ref.x.map((_x, i) => (i < 3 ? 1 : i < 5 ? 2 : 0)) // 3 x Low, 2 x Med, rest Good
    const states = ['Good', 'Low', 'Med', 'Killer', 'Uninspected']
    const palette = { Good: '#0f0', Low: '#ff0', Med: '#f80', Killer: '#f00', Uninspected: '#999' }
    const all = buildIndividualFigure(ref, codes, states, palette, colors, false, {})
    expect(all.data.filter((t) => t.type === 'scattergl' && t.mode === 'lines').map((t) => t.name)).toEqual(['Good', 'Low', 'Med'])
    // Low + Med selected; spring 0 is Low from stage S1, the others have no stage
    const stageCodes = codes.map((_c, i) => (i === 0 ? 0 : -1))
    const mask = buildMask(new Set(['Low', 'Med']), codes, states, stageCodes, ['S1'])
    const stages = stageLabels(stageCodes, ['S1'])
    const two = buildIndividualFigure(ref, codes, states, palette, colors, false, { mask, stages })
    expect(two.data.filter((t) => t.type === 'scattergl' && t.mode === 'lines').map((t) => t.name)).toEqual(['Low', 'Med'])
    const hover = two.data.find((t) => t.name === 'Springs') as { x: number[]; customdata: unknown[][] }
    expect(hover.x).toHaveLength(5)
    expect(hover.customdata[0][2]).toBe('Low · S1') // hover names the stage
  })
})

describe('code / stage selection rules', () => {
  const states = ['Good', 'BM', 'H8', 'Uninspected']
  const stages = ['PLT', 'AID']
  // positions: 0 BM/PLT, 1 BM/AID, 2 H8/AID, 3 Good
  const statusCodes = [1, 1, 2, 0]
  const stageCodes = [0, 1, 1, -1]

  it('a code shows all its stages; a stage shows only that code from that stage', () => {
    expect(buildMask(new Set(), statusCodes, states, stageCodes, stages)).toBeNull()
    expect(buildMask(new Set(['BM']), statusCodes, states, stageCodes, stages)).toEqual([true, true, false, false])
    expect(buildMask(new Set([stageKey('BM', 'AID')]), statusCodes, states, stageCodes, stages)).toEqual([false, true, false, false])
    // mix: all of H8 plus only the PLT part of BM
    expect(buildMask(new Set(['H8', stageKey('BM', 'PLT')]), statusCodes, states, stageCodes, stages)).toEqual([true, false, true, false])
  })

  it('toggles codes and stages without contradictions', () => {
    let sel = toggleStage(new Set(), 'BM', 'PLT')
    expect([...sel]).toEqual([stageKey('BM', 'PLT')])
    sel = toggleCode(sel, 'BM') // whole code replaces its single stages
    expect([...sel]).toEqual(['BM'])
    expect(stageShown(sel, 'BM', 'AID')).toBe(true)
    sel = toggleStage(sel, 'BM', 'AID') // narrowing a whole code to one stage
    expect([...sel]).toEqual([stageKey('BM', 'AID')])
    sel = toggleStage(sel, 'BM', 'AID')
    expect(sel.size).toBe(0)
    sel = toggleCode(toggleCode(new Set(), 'H8'), 'H8')
    expect(sel.size).toBe(0)
  })
})

describe('routing helpers', () => {
  it('opens the wafer page from ?sample= and lets #/layouts win', () => {
    expect(routeFromHash('', '?sample=W1.1&plan=3d')).toBe('wafer')
    expect(routeFromHash('#/layouts?product=X', '?sample=W1.1')).toBe('layouts')
    expect(routeFromHash('#/', '')).toBe('map')
    expect(readWaferQuery('?sample=%20W1.1%20&plan=3D')).toEqual({ sample: 'W1.1', plan: '3d' })
    expect(readWaferQuery('?sample=W1.1&plan=bogus').plan).toBeNull()
    const hash = layoutEditorHash('159-501160A', 'SEQUOIA I', '?sample=W1.1&plan=3d')
    expect(hashParams(hash).get('group')).toBe('SEQUOIA I')
    expect(safeReturn(hashParams(hash).get('return'))).toBe('?sample=W1.1&plan=3d')
    expect(safeReturn('//evil.example/x')).toBeNull()
    expect(safeReturn('?a=1"><script>')).toBeNull()
  })

  it('resolves the API relative to the page (IIS sub-application)', () => {
    expect(apiBase('https://host/wafermap/?sample=W1.1#/layouts')).toBe('/wafermap/api')
    expect(apiBase('http://localhost:5187/')).toBe('/api')
  })

  it('writes edited rows as the CSV the server validates', () => {
    const rows = [{ id: 0, die: '1', spring: '1', x: ' 1.5', y: '2' }]
    expect(rowsToCsv(rows, 'die')).toBe('Die_Num,X,Y\n1,1.5,2\n')
    expect(rowsToCsv(rows, 'spring')).toBe('Die_Num,Spring_Num,X,Y\n1,1,1.5,2\n')
  })
})

describe('Wafer map page', () => {
  it('draws the newest file for the sample with its layout and farm dies', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    const { calls } = installFetchStub({ '/api/wafermap': () => json(makeWaferMap()) })
    render(<App />)
    expect(await screen.findByTestId('wafer-map')).toBeInTheDocument()
    expect(calls.map((c) => c.url)).toEqual(['/api/wafermap?sample=W305463.5&plan=3d'])
    expect(screen.getByTestId('wafer-title')).toHaveTextContent('W305463.5')
    expect(screen.getByTestId('layout-pill')).toHaveTextContent('SEQUOIA-I · rev 2')
    expect(screen.getByTestId('kpi-yield')).toHaveTextContent('66.7%')
    expect(within(screen.getByTestId('status-counts')).getByText('UD').closest('button')).toHaveTextContent('1')
    expect(screen.getByTestId('source-file')).toHaveTextContent('iXML#1817_3D_YIELD_MONITOR')
    // die 1 is a farm die: exactly one dotted cell outline in the drawn figure
    const dotted = () => {
      const fig = [...reactCalls].reverse().find((c) => Array.isArray(c.layout.shapes) && (c.layout.shapes as unknown[]).length === 4)
      return (fig?.layout.shapes as { line: { dash?: string } }[] | undefined)?.filter((sh) => sh.line.dash === 'dot').length
    }
    await waitFor(() => expect(dotted()).toBe(1))
  })

  it('shows NO LAYOUT AVAILABLE with a link into the Layout Editor', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    installFetchStub({
      '/api/wafermap': () => json(makeWaferMap({ status: 'no_layout', layout: null, map: null, message: 'No layout is saved for product 159-501160A or product group SEQUOIA I.' })),
      '/api/layouts': () => json({ layouts: [] }),
    })
    render(<App />)
    const panel = await screen.findByTestId('no-layout')
    expect(panel).toHaveTextContent('NO LAYOUT AVAILABLE')
    expect(screen.queryByTestId('wafer-map')).not.toBeInTheDocument()
    const link = screen.getByTestId('open-editor')
    const href = link.getAttribute('href') ?? ''
    expect(href.startsWith('#/editor?')).toBe(true) // the standalone Layout Editor, not the prototype page
    expect(hashParams(href).get('product')).toBe('159-501160A')
    expect(hashParams(href).get('return')).toBe('?sample=W305463.5&plan=3d')

    await userEvent.click(link)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(await screen.findByTestId('editor-context')).toHaveTextContent('159-501160A')
    // no layout serves this wafer yet: the editor starts a new one, prefilled for it
    expect(await screen.findByTestId('upload-panel')).toBeInTheDocument()
    expect(screen.getByLabelText('Products (PRODUCT)')).toHaveValue('159-501160A')
    expect(screen.getByLabelText(/Product groups/)).toHaveValue('SEQUOIA I')
    expect(screen.getByTestId('back-to-wafer')).toHaveAttribute('href', '/?sample=W305463.5&plan=3d')
  })

  it('explains a layout that does not match and a sample that is not found', async () => {
    setUrl('?sample=W305463.5')
    installFetchStub({
      '/api/wafermap': () => json(makeWaferMap({ status: 'layout_mismatch', map: null, message: '3 of 8 spring keys are not present' })),
    })
    const view = render(<App />)
    expect(await screen.findByTestId('no-layout')).toHaveTextContent('LAYOUT DOES NOT MATCH THIS WAFER')
    view.unmount()

    installFetchStub({ '/api/wafermap': () => json({ detail: 'No 3D iXML file for sample W305463.5 was found in the last 365 days' }, 404) })
    render(<App />)
    expect(await screen.findByTestId('wafer-error')).toHaveTextContent('was found in the last 365 days')
  })
})

describe('Layout history', () => {
  const detail: LayoutDetail = {
    name: 'L', file: 'L.r002.csv', products: ['159-501160A'], product_groups: [], implicit: false, hidden: false,
    saved_at: '2026-11-12T10:00:00+00:00', source_filename: 'l.csv', revision: 2, revision_count: 2, author: 'bob', note: 'bad edit',
    size_bytes: 100, summary: null, error: null,
    revisions: [
      { rev: 2, file: 'L.r002.csv', saved_at: '2026-11-12T10:00:00+00:00', author: 'bob', note: 'bad edit', source_filename: 'l.csv', action: 'edit', restored_from: null, products: ['159-501160A'], product_groups: [], current: true, available: true },
      { rev: 1, file: 'L.csv', saved_at: '2026-11-11T10:00:00+00:00', author: 'ann', note: '', source_filename: 'l.csv', action: 'upload', restored_from: null, products: ['159-501160A'], product_groups: [], current: false, available: true },
    ],
  }
  const geometry = (rev: number): LayoutGeometry => ({
    name: 'L', rev, kind: 'die', pitch: { x: 10, y: 10 }, die: [1, 2], spring: [1, 1], x: [-5, 5], y: [0, 0], source_x: [0, 10], source_y: [0, 0],
    gangs: [{ die: 1, xmin: -5, xmax: -5, ymin: 0, ymax: 0 }, { die: 2, xmin: 5, xmax: 5, ymin: 0, ymax: 0 }],
    summary: { springs: 2, gangs: 2, springs_per_gang_min: 1, springs_per_gang_max: 1, center_x: 5, center_y: 0, x_min: 0, x_max: 10, y_min: 0, y_max: 0, max_radius_mm: 5, kind: 'die', units: 'mm', pitch_x_mm: 10, pitch_y_mm: 10, warnings: [] },
    caveat: 'Notch down assumed.',
  })

  it('restores an old revision and saves browser edits as a new revision', async () => {
    setUrl('', '#/layouts')
    const listItem = { ...detail, revisions: undefined }
    let current: LayoutDetail = detail
    const { calls } = installFetchStub({
      '/api/layouts': (init) => (init?.method === 'POST'
        ? json({ ...listItem, revision: 4 })
        : json({ layouts: [listItem] })),
      '/api/layouts/L': () => json(current),
      '/api/layouts/L/revisions/3': () => json(geometry(3)),
      '/api/layouts/L/revisions/2': () => json(geometry(2)),
      '/api/layouts/L/revisions/1': () => json(geometry(1)),
      '/api/layouts/L/restore': () => {
        current = {
          ...detail, revision: 3, revision_count: 3,
          revisions: [
            { ...detail.revisions[1], rev: 3, action: 'restore', restored_from: 1, note: 'Restored revision 1', current: true },
            ...detail.revisions.map((r) => ({ ...r, current: false })),
          ],
        }
        return json({ ...listItem, revision: 3 })
      },
    })
    render(<App />)
    await userEvent.click(await screen.findByTestId('history-L'))
    expect(await screen.findByTestId('revisions-table')).toHaveTextContent('bad edit')
    await userEvent.click(screen.getByTestId('restore-rev-1'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/layouts/L/restore')).toBe(true))
    expect(calls.find((c) => c.url === '/api/layouts/L/restore')?.body).toMatchObject({ rev: 1 })
    expect(await screen.findByTestId('history-message')).toHaveTextContent('Revision 1 restored as revision 3')

    await waitFor(() => expect(screen.getByTestId('edit-layout')).not.toBeDisabled())
    await userEvent.click(screen.getByTestId('edit-layout'))
    const x = await screen.findByLabelText('X of row 1')
    await userEvent.clear(x)
    await userEvent.type(x, '10.5')
    await userEvent.click(screen.getByTestId('save-revision'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/layouts' && c.method === 'POST')).toBe(true))
    const save = calls.find((c) => c.url === '/api/layouts' && c.method === 'POST')
    expect(save?.body).toMatchObject({ name: 'L', replace: 'true', action: 'edit', file: 'L-edited.csv' })
  })
})

describe('Wafer map page layout', () => {
  it('puts the list beside the map and shows only the selected codes (several at once)', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    installFetchStub({ '/api/wafermap': () => json(makeWaferMap()) })
    render(<App />)
    await screen.findByTestId('wafer-map')
    // the status list is part of the map unit, not the sidebar
    const pair = screen.getByTestId('wafer-map').closest('.map-pair') as HTMLElement
    expect(pair).toContainElement(screen.getByTestId('status-counts'))
    expect(screen.getByLabelText('Wafer details')).not.toContainElement(screen.getByTestId('status-counts'))
    const lastFigure = () => reactCalls[reactCalls.length - 1]
    expect(lastFigure().layout.showlegend).toBe(false) // the sidebar list is the legend
    const fills = () => (lastFigure().layout.shapes as { fillcolor: string }[]).map((sh) => sh.fillcolor)
    const clear = 'rgba(0,0,0,0)'
    const list = screen.getByTestId('status-counts')
    await userEvent.click(within(list).getByText('UD'))
    await waitFor(() => expect(fills()).toEqual([clear, clear, '#df3537', clear])) // only die 3 (UD) is filled
    await userEvent.click(within(list).getByText('Good')) // add a second code
    await waitFor(() => expect(fills()).toEqual(['#21a653', '#21a653', '#df3537', '#21a653']))
    expect(within(list).getByText('Good').closest('button')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(list).getByText('UD')) // remove one
    await waitFor(() => expect(fills()).toEqual(['#21a653', '#21a653', clear, '#21a653']))
    await userEvent.click(screen.getByTestId('show-all'))
    await waitFor(() => expect(fills()).toEqual(['#21a653', '#21a653', '#df3537', '#21a653']))
    expect(screen.queryByTestId('show-all')).not.toBeInTheDocument()
  })
})

describe('Wafer map page chrome', () => {
  it('has no app header; actions sit on the wafer card and metrics head the status list', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    installFetchStub({ '/api/wafermap': () => json(makeWaferMap()) })
    render(<App />)
    await screen.findByTestId('wafer-map')
    expect(screen.queryByRole('link', { name: 'Workbench' })).not.toBeInTheDocument()
    expect(screen.queryByText('Wafer Defect Map Intelligence')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Switch to (light|dark) theme/ })).toBeInTheDocument()
    expect(screen.getByText('Notch ↓ (assumed)')).toBeInTheDocument()
    // metrics are rows of the wafer card, after Orientation; there is no die-label toggle
    const card = screen.getByLabelText('Wafer metrics')
    expect(card).toContainElement(screen.getByTestId('kpi-yield'))
    expect(card).toHaveTextContent(/Orientation.*Yield.*Scrapped.*Dies.*Inspected/)
    expect(screen.queryByLabelText('Die labels')).not.toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'Page actions' })).toContainElement(screen.getByTestId('open-editor-small'))
  })
})

describe('Wafer map page labels', () => {
  it('shows the sample first, the collection plan, a compact toolbar and no list heading', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    installFetchStub({ '/api/wafermap': () => json(makeWaferMap()) })
    render(<App />)
    await screen.findByTestId('wafer-map')
    const card = screen.getByLabelText('Wafer metrics')
    expect(card.firstElementChild).toBe(screen.getByTestId('wafer-title'))
    expect(card).not.toHaveTextContent('Wafer ·')
    expect(screen.getByTestId('collection-plan')).toHaveTextContent('3D_YIELD_MONITOR')
    expect(screen.getByTestId('open-editor-small')).toHaveTextContent(/^Layout Editor$/)
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveTextContent('↻')
    expect(screen.getByLabelText('Status counts')).not.toHaveTextContent(/Status ·/)
  })
})

describe('scrap stages in the list', () => {
  it('expands a code into its stages and filters the map to one stage', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    const base = makeWaferMap()
    const data = makeWaferMap({
      status_counts: [{ status: 'Good', count: 2 }, { status: 'UD', count: 2 }],
      status_stages: { UD: [{ stage: '4355ASTR', count: 1 }, { stage: '3085BSINS', count: 1 }] },
      map: { ...(base.map as NonNullable<typeof base.map>), status_codes: [0, 1, 1, 0], stages: ['4355ASTR', '3085BSINS'], stage_codes: [-1, 0, 1, -1] },
    })
    installFetchStub({ '/api/wafermap': () => json(data) })
    render(<App />)
    await screen.findByTestId('wafer-map')
    const fills = () => (reactCalls[reactCalls.length - 1].layout.shapes as { fillcolor: string }[]).map((sh) => sh.fillcolor)
    const clear = 'rgba(0,0,0,0)'
    expect(screen.queryByTestId('expand-Good')).not.toBeInTheDocument() // no stage recorded for Good here
    await userEvent.click(screen.getByTestId('expand-UD'))
    const stagesList = screen.getByLabelText('Scrap stages of UD')
    expect(stagesList).toHaveTextContent('4355ASTR')
    await userEvent.click(within(stagesList).getByText('3085BSINS'))
    await waitFor(() => expect(fills()).toEqual([clear, clear, '#df3537', clear])) // die 3 only (UD from 3085BSINS)
    await userEvent.click(within(screen.getByTestId('status-counts')).getByText('UD')) // whole code
    await waitFor(() => expect(fills()).toEqual([clear, '#df3537', '#df3537', clear]))
  })
})

describe('banked stage for Good', () => {
  it('lists Good by its banked stage (PROCESS) and filters to it, even with a single stage', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    const base = makeWaferMap()
    const data = makeWaferMap({
      status_counts: [{ status: 'Good', count: 3 }, { status: 'UD', count: 1 }],
      status_stages: { Good: [{ stage: '4595SDBANK', count: 3 }], UD: [{ stage: '38080SPIN', count: 1 }] },
      map: { ...(base.map as NonNullable<typeof base.map>), stages: ['4595SDBANK', '38080SPIN'], stage_codes: [0, 0, 1, 0] },
    })
    installFetchStub({ '/api/wafermap': () => json(data) })
    render(<App />)
    await screen.findByTestId('wafer-map')
    expect(screen.getByTestId('expand-UD')).toBeInTheDocument() // single scrap stage: still expandable
    await userEvent.click(screen.getByTestId('expand-Good'))
    const banked = screen.getByLabelText('Banked stages of Good')
    expect(banked).toHaveTextContent('4595SDBANK')
    await userEvent.click(within(banked).getByText('4595SDBANK'))
    const fills = () => (reactCalls[reactCalls.length - 1].layout.shapes as { fillcolor: string }[]).map((sh) => sh.fillcolor)
    await waitFor(() => expect(fills()).toEqual(['#21a653', '#21a653', 'rgba(0,0,0,0)', '#21a653']))
  })
})

describe('map filter rules', () => {
  const R = (r: Partial<FilterRule>): FilterRule => ({ field: 'stage', op: 'num_lt', value: '4900', digits: 4, ...r })
  it('reads the first N digits of a stage as a number', () => {
    expect(stageNumber('4025S3PLT', 4)).toBe(4025)
    expect(stageNumber('38080SPIN', 4)).toBe(3808)
    expect(stageNumber('38080SPIN', 5)).toBe(38080)
    expect(stageNumber('S9X', 4)).toBeNull()
    expect(stageNumber(null, 4)).toBeNull()
  })
  it('matches stage, code and kind rules with all / any', () => {
    expect(ruleMatches(R({}), 'BM', '4025S3PLT')).toBe(true)
    expect(ruleMatches(R({}), 'BM', '4533GIAID')).toBe(true)
    expect(ruleMatches(R({ value: '4500' }), 'BM', '4533GIAID')).toBe(false)
    expect(ruleMatches(R({}), 'BM', null)).toBe(false) // no stage, no number
    expect(ruleMatches(R({ op: 'starts_with', value: '7' }), 'BM', '7012ABC')).toBe(true)
    expect(ruleMatches(R({ op: 'equals', value: '3848s2aid' }), 'H8', '3848S2AID')).toBe(true)
    expect(ruleMatches(R({ field: 'code', op: 'in', value: 'H8, BM' }), 'BM', 'x')).toBe(true)
    expect(ruleMatches(R({ field: 'kind', op: 'equals', value: 'defect' }), 'Good', '4540QINSP')).toBe(false)
    const defectsBefore4900: FilterDefinition = { match: 'all', rules: [R({ field: 'kind', op: 'equals', value: 'defect' }), R({})] }
    expect(definitionMatches(defectsBefore4900, 'BM', '4025S3PLT')).toBe(true)
    expect(definitionMatches(defectsBefore4900, 'Good', '4540QINSP')).toBe(false)
    expect(definitionMatches({ ...defectsBefore4900, match: 'any' }, 'Good', '4540QINSP')).toBe(true)
    expect(describeDefinition(defectsBefore4900)).toBe('Status kind is defect AND Stage first 4 digits < 4900')
    expect(ruleProblem(R({ value: 'abc' }))).toBe('Enter a number.')
  })
  it('recounts the list inside a filter', () => {
    const data = makeWaferMap({
      status_counts: [{ status: 'Good', count: 3 }, { status: 'UD', count: 1 }],
      map: { ...(makeWaferMap().map as NonNullable<WaferMap['map']>), stages: ['4595SDBANK', '7001X'], stage_codes: [0, 0, 1, 0] },
    })
    const mask = filterMask({ match: 'all', rules: [R({ op: 'starts_with', value: '7' })] }, data) as boolean[]
    expect(mask).toEqual([false, false, true, false])
    expect(countsWithin(data, mask)).toEqual({ status_counts: [{ status: 'UD', count: 1 }], status_stages: { UD: [{ stage: '7001X', count: 1 }] } })
  })
})

describe('map filter dialog', () => {
  it('builds a filter, applies it to the map, saves it and shows it as the active filter', async () => {
    setUrl('?sample=W305463.5&plan=3d')
    const base = makeWaferMap()
    const data = makeWaferMap({ map: { ...(base.map as NonNullable<typeof base.map>), stages: ['4595SDBANK', '7001X'], stage_codes: [0, 0, 1, 0] } })
    const saved: SavedMapFilter[] = []
    const { calls } = installFetchStub({
      '/api/wafermap': () => json(data),
      '/api/map-filters': (init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { name: string; definition: FilterDefinition }
          const f: SavedMapFilter = { id: 'f1', name: body.name, hidden: false, revision: 1, revision_count: 1, saved_at: '2026-11-12T10:00:00+00:00', author: '', note: '', definition: body.definition, copied_from: null }
          saved.push(f)
          return json(f)
        }
        return json({ filters: saved })
      },
      '/api/map-filters/f1': () => json({ ...saved[0], revisions: [{ rev: 1, saved_at: saved[0].saved_at, author: '', note: '', action: 'create', name: saved[0].name, definition: saved[0].definition }] }),
    })
    render(<App />)
    await screen.findByTestId('wafer-map')
    await userEvent.click(screen.getByTestId('open-filters'))
    const dialog = await screen.findByRole('dialog', { name: 'Map filters' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Operator of rule 1'), 'starts_with')
    await userEvent.type(within(dialog).getByLabelText('Value of rule 1'), '7')
    expect(within(dialog).getByTestId('filter-preview')).toHaveTextContent('Matches 1 of 4 dies')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Stage 7xxx')
    await userEvent.click(within(dialog).getByTestId('save-filter'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/map-filters' && c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/map-filters')?.body).toMatchObject({ name: 'Stage 7xxx', definition: { match: 'all', rules: [{ field: 'stage', op: 'starts_with', value: '7' }] } })
    await userEvent.click(within(dialog).getByTestId('apply-draft'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('active-filter')).toHaveTextContent('Stage 7xxx · rev 1')
    const fills = () => (reactCalls[reactCalls.length - 1].layout.shapes as { fillcolor: string }[]).map((sh) => sh.fillcolor)
    await waitFor(() => expect(fills()).toEqual(['rgba(0,0,0,0)', 'rgba(0,0,0,0)', '#df3537', 'rgba(0,0,0,0)']))
    expect(within(screen.getByTestId('status-counts')).queryByText('Good')).not.toBeInTheDocument() // list recounted inside the filter
    await userEvent.click(screen.getByRole('button', { name: 'Remove map filter' }))
    await waitFor(() => expect(fills()).toEqual(['#21a653', '#21a653', '#df3537', '#21a653']))
  })
})

describe('Wafer -> Die -> Feature wording', () => {
  it('names the unit inside a die "Feature" on the wafer page, map hover and layout preview', async () => {
    setUrl('?sample=W304235.1&plan=2d')
    const base = makeWaferMap()
    const ref = makeReference()
    const data = makeWaferMap({
      level: 'feature', plan: '2d',
      summary: { ...base.summary, unit: 'feature', farm_dies: 0, farm_good: 0 },
      farm_dies: [],
      map: { ...(base.map as NonNullable<typeof base.map>), kind: 'spring', pitch: null, die: ref.die, spring: ref.spring, x: ref.x, y: ref.y, gangs: ref.gangs, status_codes: ref.x.map(() => 0), stages: [], stage_codes: ref.x.map(() => -1) },
    })
    installFetchStub({ '/api/wafermap': () => json(data) })
    render(<App />)
    await screen.findByTestId('wafer-map')
    expect(screen.getByLabelText('Wafer metrics')).toHaveTextContent(/good of \d+ features/)
    expect(screen.getByLabelText('Wafer metrics')).not.toHaveTextContent(/spring/i)
    await waitFor(() => {
      const hover = reactCalls[reactCalls.length - 1].data.find((t) => t.name === 'Springs') as { hovertemplate: string }
      expect(hover.hovertemplate).toContain('| Feature %{customdata[1]}')
    })
    const layoutFig = buildLayoutFigure({ kind: 'spring', pitch: null, die: ref.die, spring: ref.spring, x: ref.x, y: ref.y, gangs: ref.gangs }, resolveChartColors('dark'), true)
    expect(JSON.stringify(layoutFig.data)).toContain('| Feature %{customdata[1]}')
  })
})
