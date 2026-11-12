/* Map filters: rules that decide which features / dies are drawn, evaluated in
   the browser on the per-position status and stage the API already sends.
   The same shape is stored by the backend (wafermap/filters.py), which only
   validates it. Pure functions, tested directly. */

import type { FilterDefinition, FilterField, FilterOp, FilterRule, WaferMap } from '../../api/types'

export type { FilterDefinition, FilterField, FilterOp, FilterRule }

export const FIELD_LABELS: Record<FilterField, string> = { stage: 'Stage', code: 'Code', kind: 'Status kind' }

export const OPS_BY_FIELD: Record<FilterField, { op: FilterOp; label: string }[]> = {
  stage: [
    { op: 'num_lt', label: 'first N digits <' },
    { op: 'num_le', label: 'first N digits ≤' },
    { op: 'num_gt', label: 'first N digits >' },
    { op: 'num_ge', label: 'first N digits ≥' },
    { op: 'starts_with', label: 'starts with' },
    { op: 'not_starts_with', label: 'does not start with' },
    { op: 'equals', label: 'equals' },
    { op: 'not_equals', label: 'does not equal' },
    { op: 'contains', label: 'contains' },
    { op: 'in', label: 'is one of' },
    { op: 'is_empty', label: 'is not recorded' },
    { op: 'not_empty', label: 'is recorded' },
  ],
  code: [
    { op: 'equals', label: 'equals' },
    { op: 'not_equals', label: 'does not equal' },
    { op: 'in', label: 'is one of' },
    { op: 'starts_with', label: 'starts with' },
  ],
  kind: [{ op: 'equals', label: 'is' }],
}

export const NUMBER_OPS: ReadonlySet<FilterOp> = new Set(['num_lt', 'num_le', 'num_gt', 'num_ge'])
const NO_VALUE_OPS: ReadonlySet<FilterOp> = new Set(['is_empty', 'not_empty'])

export function needsValue(op: FilterOp): boolean {
  return !NO_VALUE_OPS.has(op)
}

/* Leading `digits` characters of a stage as a number, or null when they are not all digits. */
export function stageNumber(stage: string | null, digits: number): number | null {
  if (!stage) return null
  const head = stage.slice(0, digits)
  return head.length === digits && /^\d+$/.test(head) ? Number(head) : null
}

function list(value: string): string[] {
  return value.split(/[,;\s]+/).map((v) => v.trim().toUpperCase()).filter(Boolean)
}

function textTest(op: FilterOp, actual: string | null, value: string): boolean {
  const a = (actual ?? '').toUpperCase()
  const v = value.trim().toUpperCase()
  switch (op) {
    case 'equals': return a === v
    case 'not_equals': return a !== v
    case 'starts_with': return actual !== null && a.startsWith(v)
    case 'not_starts_with': return !(actual !== null && a.startsWith(v))
    case 'contains': return actual !== null && a.includes(v)
    case 'in': return list(value).includes(a)
    case 'is_empty': return actual === null || a === ''
    case 'not_empty': return actual !== null && a !== ''
    default: return false
  }
}

/* One unit (status + stage) against one rule. Number rules never match a stage without a number. */
export function ruleMatches(rule: FilterRule, status: string, stage: string | null): boolean {
  if (rule.field === 'kind') {
    const kind = status === 'Good' ? 'good' : 'defect'
    return kind === rule.value.trim().toLowerCase()
  }
  if (rule.field === 'code') return textTest(rule.op, status, rule.value)
  if (NUMBER_OPS.has(rule.op)) {
    const n = stageNumber(stage, rule.digits ?? 4)
    const v = Number(rule.value)
    if (n === null || !Number.isFinite(v)) return false
    switch (rule.op) {
      case 'num_lt': return n < v
      case 'num_le': return n <= v
      case 'num_gt': return n > v
      case 'num_ge': return n >= v
      default: return false
    }
  }
  return textTest(rule.op, stage, rule.value)
}

export function definitionMatches(def: FilterDefinition, status: string, stage: string | null): boolean {
  if (def.rules.length === 0) return true
  return def.match === 'any'
    ? def.rules.some((r) => ruleMatches(r, status, stage))
    : def.rules.every((r) => ruleMatches(r, status, stage))
}

/* A rule the backend would reject, as a message; null when fine. */
export function ruleProblem(rule: FilterRule): string | null {
  if (!OPS_BY_FIELD[rule.field].some((o) => o.op === rule.op)) return 'Choose an operator.'
  if (NUMBER_OPS.has(rule.op) && !Number.isFinite(Number(rule.value.trim() || 'x'))) return 'Enter a number.'
  if (needsValue(rule.op) && !rule.value.trim()) return 'Enter a value.'
  return null
}

/* Per map position: inside the filter or not (uninspected positions never are). */
export function filterMask(def: FilterDefinition, data: WaferMap): boolean[] | null {
  const m = data.map
  if (!m) return null
  return m.status_codes.map((code, i) => {
    const status = data.states[code] ?? 'Uninspected'
    if (status === 'Uninspected') return false
    const s = m.stage_codes && m.stage_codes[i] >= 0 && m.stages ? m.stages[m.stage_codes[i]] : null
    return definitionMatches(def, status, s)
  })
}

/* The status list's numbers recounted inside a filter (codes with nothing left are dropped). */
export function countsWithin(data: WaferMap, mask: readonly boolean[]): Pick<WaferMap, 'status_counts' | 'status_stages'> {
  const m = data.map
  if (!m) return { status_counts: data.status_counts, status_stages: data.status_stages }
  const byStatus = new Map<string, number>()
  const byStage = new Map<string, Map<string, number>>()
  m.status_codes.forEach((code, i) => {
    if (!mask[i]) return
    const status = data.states[code] ?? 'Uninspected'
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
    const stage = m.stage_codes && m.stage_codes[i] >= 0 && m.stages ? m.stages[m.stage_codes[i]] : ''
    const stages = byStage.get(status) ?? new Map<string, number>()
    stages.set(stage, (stages.get(stage) ?? 0) + 1)
    byStage.set(status, stages)
  })
  const status_counts = data.status_counts
    .map((c) => ({ status: c.status, count: byStatus.get(c.status) ?? 0 }))
    .filter((c) => c.count > 0)
  const status_stages: NonNullable<WaferMap['status_stages']> = {}
  byStage.forEach((stages, status) => {
    status_stages[status] = [...stages.entries()]
      .map(([stage, count]) => ({ stage: stage || null, count }))
      .sort((a, b) => b.count - a.count)
  })
  return { status_counts, status_stages }
}

/* "Stage first 4 digits < 4900" - for chips and the saved list. */
export function describeRule(rule: FilterRule): string {
  const op = OPS_BY_FIELD[rule.field].find((o) => o.op === rule.op)?.label ?? rule.op
  const label = NUMBER_OPS.has(rule.op) ? op.replace('N', String(rule.digits ?? 4)) : op
  return `${FIELD_LABELS[rule.field]} ${label}${needsValue(rule.op) ? ` ${rule.value}` : ''}`
}

export function describeDefinition(def: FilterDefinition): string {
  return def.rules.map(describeRule).join(def.match === 'any' ? ' OR ' : ' AND ')
}

export function emptyRule(): FilterRule {
  return { field: 'stage', op: 'num_lt', value: '', digits: 4 }
}
