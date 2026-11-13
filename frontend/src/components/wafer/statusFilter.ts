/* What the status list has selected, and which map positions that shows.

   A selection is a set of keys:
   - a code key  ("BM")             -> every unit with that code, whatever its stage
   - a stage key ("BM" + stage)     -> only units with that code from that scrap stage
   Empty = show everything. Pure functions, no React, so the rules are tested directly. */

export type Selection = ReadonlySet<string>

const SEP = '␟' // a separator that cannot appear in a code or stage name

export function stageKey(code: string, stage: string | null): string {
  return `${code}${SEP}${stage ?? ''}`
}

function isStageKeyOf(key: string, code: string): boolean {
  return key.startsWith(`${code}${SEP}`)
}

export function codeSelected(sel: Selection, code: string): boolean {
  return sel.has(code)
}

/* A stage counts as shown when it is selected itself or its whole code is. */
export function stageShown(sel: Selection, code: string, stage: string | null): boolean {
  return sel.has(code) || sel.has(stageKey(code, stage))
}

/* Code row click: add the whole code (replacing any of its single stages), or remove it entirely. */
export function toggleCode(sel: Selection, code: string): Selection {
  const next = new Set([...sel].filter((k) => !isStageKeyOf(k, code)))
  if (sel.has(code)) next.delete(code)
  else next.add(code)
  return next
}

/* Stage row click: toggle that stage. When its whole code is selected, narrow it to just this stage. */
export function toggleStage(sel: Selection, code: string, stage: string | null): Selection {
  const key = stageKey(code, stage)
  const next = new Set(sel)
  if (next.has(code)) {
    next.delete(code)
    next.add(key)
  } else if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  return next
}

/* Per map position: drawn or not. null = no filter (draw everything). */
export function buildMask(
  sel: Selection,
  statusCodes: readonly number[],
  states: readonly string[],
  stageCodes: readonly number[] | undefined,
  stages: readonly string[] | undefined,
): boolean[] | null {
  if (sel.size === 0) return null
  return statusCodes.map((code, i) => {
    const status = states[code] ?? ''
    if (sel.has(status)) return true
    const s = stageCodes && stageCodes[i] >= 0 && stages ? stages[stageCodes[i]] : null
    return sel.has(stageKey(status, s))
  })
}

/* Per map position: its stage name for hover text (null when none). */
export function stageLabels(stageCodes: readonly number[] | undefined, stages: readonly string[] | undefined): (string | null)[] | null {
  if (!stageCodes || !stages) return null
  return stageCodes.map((c) => (c >= 0 ? stages[c] ?? null : null))
}
