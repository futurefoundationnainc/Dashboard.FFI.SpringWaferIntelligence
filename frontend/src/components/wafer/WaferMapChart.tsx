import { useMemo } from 'react'
import type { Reference, WaferMap } from '../../api/types'
import { buildIndividualFigure } from '../../charts/waferFigures'
import type { ChartColors } from '../../theme/chartColors'
import { DEFAULT_FEATURE } from '../../terms'
import { PlotlyChart } from '../PlotlyChart'
import { buildMask, stageLabels, type Selection } from './statusFilter'

interface Props {
  data: WaferMap
  colors: ChartColors
  /* Side of the square plot in px; the page computes it from the space available. */
  size: number
  /* Codes / code + stage keys to draw; empty shows all. */
  selection: Selection
  /* Positions inside the applied map filter (null = no filter); the selection narrows within it. */
  filterMask?: readonly boolean[] | null
}

/* The API's map geometry in the shape the shared figure builders draw. */
export function mapReference(data: WaferMap): Reference | null {
  const m = data.map
  if (!m) return null
  return {
    product: data.product, kind: m.kind, pitch: m.pitch, spring_count: m.x.length, gang_count: m.gangs.length,
    center: m.center, die: m.die, spring: m.spring, x: m.x, y: m.y, gangs: m.gangs, caveat: m.caveat,
  }
}

/* The wafer, drawn in an explicit square so it stays round and its legend can
   sit flush against it. Data traces are rebuilt only when the data, colors or
   selection change; a resize only changes the layout size, which Plotly.react
   applies without redrawing from scratch. */
export function WaferMapChart({ data, colors, size, selection, filterMask = null }: Props) {
  const reference = useMemo(() => mapReference(data), [data])
  const farmDies = useMemo(() => new Set(data.farm_dies), [data])
  const stages = useMemo(() => stageLabels(data.map?.stage_codes, data.map?.stages), [data])
  const mask = useMemo(() => {
    if (!data.map) return null
    const listMask = buildMask(selection, data.map.status_codes, data.states, data.map.stage_codes, data.map.stages)
    if (!filterMask) return listMask
    return listMask ? filterMask.map((inFilter, i) => inFilter && listMask[i]) : [...filterMask]
  }, [data, selection, filterMask])
  const figure = useMemo(() => {
    if (!reference || !data.map) return null
    return buildIndividualFigure(reference, data.map.status_codes, data.states, data.colors, colors, true, {
      farmDies, mask, stages, featureLabel: (data.feature_label ?? DEFAULT_FEATURE).singular, legend: false, compact: true,
    })
  }, [reference, data, colors, farmDies, mask, stages])
  const layout = useMemo(
    () => (figure ? { ...figure.layout, autosize: false, width: size, height: size } : null),
    [figure, size],
  )

  if (!figure || !layout) return null
  return (
    <div style={{ width: size, height: size }} className="plot-square">
      <PlotlyChart data={figure.data} layout={layout} className="plot-fill" testId="wafer-map" />
    </div>
  )
}
