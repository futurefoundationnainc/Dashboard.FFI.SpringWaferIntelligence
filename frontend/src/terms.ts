/* Wafer -> Die -> Feature: the one place the wafer page and the Layout Editor
   name their units. A feature is the unit inside a die (a spring on 2D
   wafers); 3D wafers have no feature level. The wafer API sends its label
   (`feature_label`), so a layout can name its features later without code
   changes; until then everything says "Feature". */

export interface FeatureLabel {
  singular: string
  plural: string
}

export const DEFAULT_FEATURE: FeatureLabel = { singular: 'Feature', plural: 'Features' }

/* The counted unit of a wafer map: dies on die-level wafers, features otherwise. */
export function unitWord(level: 'die' | 'feature', feature: FeatureLabel = DEFAULT_FEATURE, plural = true): string {
  if (level === 'die') return plural ? 'dies' : 'die'
  return (plural ? feature.plural : feature.singular).toLowerCase()
}
