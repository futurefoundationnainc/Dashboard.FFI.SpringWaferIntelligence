/* Editable coordinate rows of a layout and what they draw.

   The editor edits source coordinates (Die, Feature #, X, Y in the file's
   units). To redraw the map live while editing, rows are converted here the
   same way the server parses a file (backend/engine/reference.py): values
   beyond 1,000 are micrometres (÷ 1000), and positions are centered on the
   bounding-box midpoint. The server stays the authority: saving sends the rows
   as CSV and it validates them like an upload. Pure functions, tested directly. */

import type { GangBounds, LayoutGeometry, LayoutKind, Pitch } from '../../api/types'

export interface EditRow {
  id: number
  die: string
  feature: string
  x: string
  y: string
}

export interface DrawableLayout {
  kind: LayoutKind
  pitch: Pitch | null
  die: number[]
  spring: number[]
  x: number[]
  y: number[]
  gangs: GangBounds[]
}

const MICROMETRE_THRESHOLD = 1000

export function rowsFromGeometry(g: LayoutGeometry): EditRow[] {
  return g.die.map((d, i) => ({ id: i, die: String(d), feature: String(g.spring[i]), x: String(g.source_x[i]), y: String(g.source_y[i]) }))
}

/* The CSV the backend parses (same rules as an uploaded file). Die layouts have no feature column. */
export function rowsToCsv(rows: EditRow[], kind: LayoutKind): string {
  const header = kind === 'die' ? 'Die_Num,X,Y' : 'Die_Num,Spring_Num,X,Y'
  const lines = rows.map((r) => (kind === 'die' ? [r.die, r.x, r.y] : [r.die, r.feature, r.x, r.y]).map((v) => v.trim()).join(','))
  return [header, ...lines].join('\n') + '\n'
}

/* The first thing the server would reject, as a message; null when the rows look valid. */
export function rowsProblem(rows: EditRow[], kind: LayoutKind): string | null {
  if (rows.length === 0) return 'A layout needs at least one row.'
  const seen = new Set<string>()
  for (const r of rows) {
    const die = Number(r.die)
    const feature = kind === 'die' ? 1 : Number(r.feature)
    if (!Number.isInteger(die) || r.die.trim() === '') return `Die "${r.die}" must be a whole number.`
    if (kind !== 'die' && (!Number.isInteger(feature) || r.feature.trim() === '')) return `Feature "${r.feature}" of die ${r.die} must be a whole number.`
    if (!Number.isFinite(Number(r.x)) || r.x.trim() === '' || !Number.isFinite(Number(r.y)) || r.y.trim() === '') {
      return `Die ${r.die}${kind === 'die' ? '' : ` feature ${r.feature}`}: X and Y must be numbers.`
    }
    const key = `${die}|${feature}`
    if (seen.has(key)) return kind === 'die' ? `Die ${die} appears twice.` : `Die ${die} feature ${feature} appears twice.`
    seen.add(key)
  }
  return null
}

/* Rows -> what the map draws (centered, mm). null while the rows are not valid. */
export function rowsToDrawable(rows: EditRow[], kind: LayoutKind, pitch: Pitch | null): DrawableLayout | null {
  if (rowsProblem(rows, kind)) return null
  let xs = rows.map((r) => Number(r.x))
  let ys = rows.map((r) => Number(r.y))
  if (Math.max(...xs.map(Math.abs), ...ys.map(Math.abs)) > MICROMETRE_THRESHOLD) {
    xs = xs.map((v) => v / 1000)
    ys = ys.map((v) => v / 1000)
  }
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const x = xs.map((v) => v - cx)
  const y = ys.map((v) => v - cy)
  const die = rows.map((r) => Number(r.die))
  const spring = rows.map((r) => (kind === 'die' ? 1 : Number(r.feature)))
  const bounds = new Map<number, GangBounds>()
  die.forEach((d, i) => {
    const b = bounds.get(d)
    if (!b) bounds.set(d, { die: d, xmin: x[i], xmax: x[i], ymin: y[i], ymax: y[i] })
    else bounds.set(d, { die: d, xmin: Math.min(b.xmin, x[i]), xmax: Math.max(b.xmax, x[i]), ymin: Math.min(b.ymin, y[i]), ymax: Math.max(b.ymax, y[i]) })
  })
  const gangs = [...bounds.values()].sort((a, b) => a.die - b.die)
  return { kind, pitch, die, spring, x, y, gangs }
}
