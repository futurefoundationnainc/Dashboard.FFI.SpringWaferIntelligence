/* Sizing of the Wafer Map page's main row: [ map card: square map + status list ] [ details ].
   The map is the largest square that fits the available height and, beside
   the fixed-width list, the width left after the details column's minimum.
   The map card is then exactly as wide as its contents, and the details
   column takes whatever width remains (no dead space beside the wafer). */

export const LEGEND_WIDTH = 170
export const LEGEND_WIDTH_EXPANDED = 240 // while a code shows its scrap stages (names like 3789S2LAID)
export const PAIR_GAP = 12
export const CARD_PAD_X = 30 // .card horizontal padding (2 x 14px) + borders
export const STAGE_GAP = 14
export const SIDEBAR_MIN = 340
export const MIN_MAP = 280
export const DEFAULT_MAP = 640 // before the first measurement (and in tests)

export interface PairInput {
  /* Width of the whole row (map card + gap + details). */
  stageWidth: number | null
  /* Space inside the map card for the map + list. */
  hostWidth: number | null
  hostHeight: number | null
  /* Narrow screens put the details under the map instead of beside it. */
  stacked: boolean
  /* Width of the status list (wider while stages are expanded). */
  legendWidth?: number
}

export interface PairLayout {
  /* Side of the square map, px. */
  side: number
  /* Width of the map card column, px (null when stacked: full width). */
  mapColumn: number | null
}

export function pairLayout({ stageWidth, hostWidth, hostHeight, stacked, legendWidth = LEGEND_WIDTH }: PairInput): PairLayout {
  if (hostHeight === null || (stacked ? hostWidth === null : stageWidth === null)) return { side: DEFAULT_MAP, mapColumn: null }
  const widthForPair = stacked ? (hostWidth as number) : (stageWidth as number) - SIDEBAR_MIN - STAGE_GAP - CARD_PAD_X
  const side = Math.max(MIN_MAP, Math.floor(Math.min(hostHeight, widthForPair - legendWidth - PAIR_GAP)))
  return { side, mapColumn: stacked ? null : side + PAIR_GAP + legendWidth + CARD_PAD_X }
}
