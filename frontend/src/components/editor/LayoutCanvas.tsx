import { useMemo } from 'react'
import { buildLayoutFigure } from '../../charts/waferFigures'
import type { ChartColors } from '../../theme/chartColors'
import { PlotlyChart } from '../PlotlyChart'
import type { DrawableLayout } from './coordinateRows'

interface Props {
  layout: DrawableLayout | null
  colors: ChartColors
  size: number
  /* Shown in place of the map when there is nothing to draw. */
  emptyText: string
}

/* The layout drawn as a square wafer (dies as cells, features as 4 mm
   segments), with die outlines and labels. */
export function LayoutCanvas({ layout, colors, size, emptyText }: Props) {
  const figure = useMemo(() => (layout ? buildLayoutFigure(layout, colors, true, 'Feature') : null), [layout, colors])
  const sized = useMemo(
    () => (figure ? { ...figure.layout, autosize: false, width: size, height: size, margin: { l: 40, r: 12, t: 12, b: 36 } } : null),
    [figure, size],
  )
  if (!figure || !sized) {
    return (
      <div className="editor-empty" style={{ width: size, height: size }} data-testid="editor-empty">
        {emptyText}
      </div>
    )
  }
  return (
    <div style={{ width: size, height: size }}>
      <PlotlyChart data={figure.data} layout={sized} className="plot-fill" testId="editor-map" />
    </div>
  )
}
