import type { FilterField, FilterOp, FilterRule } from '../../api/types'
import { FIELD_LABELS, NUMBER_OPS, OPS_BY_FIELD, needsValue, ruleProblem } from './mapFilter'

interface Props {
  rule: FilterRule
  index: number
  onChange: (rule: FilterRule) => void
  onRemove: () => void
}

const PLACEHOLDER: Partial<Record<FilterOp, string>> = {
  num_lt: 'e.g. 4900', num_le: 'e.g. 4900', num_gt: 'e.g. 4000', num_ge: 'e.g. 4000',
  starts_with: 'e.g. 7', not_starts_with: 'e.g. 7', equals: 'e.g. 3848S2AID', in: 'e.g. H8, BM',
}

/* One condition of a map filter: field, operator, value (+ digits for number rules). */
export function FilterRuleRow({ rule, index, onChange, onRemove }: Props) {
  const problem = ruleProblem(rule)
  const setField = (field: FilterField) => {
    const op = OPS_BY_FIELD[field][0].op
    onChange({ field, op, value: field === 'kind' ? 'defect' : '', digits: rule.digits ?? 4 })
  }
  return (
    <div className="filter-rule" data-testid={`rule-${index}`}>
      <select aria-label={`Field of rule ${index + 1}`} className="input" value={rule.field} onChange={(e) => setField(e.target.value as FilterField)}>
        {(Object.keys(FIELD_LABELS) as FilterField[]).map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
      </select>
      {NUMBER_OPS.has(rule.op) && (
        <label className="digits-field" title="How many leading characters of the stage form the number">
          first
          <input
            aria-label={`Digits of rule ${index + 1}`}
            className="input"
            type="number"
            min={1}
            max={12}
            value={rule.digits ?? 4}
            onChange={(e) => onChange({ ...rule, digits: Math.max(1, Math.min(12, Number(e.target.value) || 4)) })}
          />
          digits
        </label>
      )}
      <select aria-label={`Operator of rule ${index + 1}`} className="input" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as FilterOp })}>
        {OPS_BY_FIELD[rule.field].map((o) => (
          <option key={o.op} value={o.op}>{NUMBER_OPS.has(o.op) ? o.label.replace('first N digits ', '') : o.label}</option>
        ))}
      </select>
      {rule.field === 'kind' ? (
        <select aria-label={`Value of rule ${index + 1}`} className="input" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value })}>
          <option value="defect">Defect</option>
          <option value="good">Good</option>
        </select>
      ) : needsValue(rule.op) ? (
        <input
          aria-label={`Value of rule ${index + 1}`}
          className={`input ${problem ? 'input-invalid' : ''}`}
          type="text"
          value={rule.value}
          placeholder={PLACEHOLDER[rule.op] ?? ''}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
      ) : <span />}
      <button type="button" className="btn btn-sm icon-btn" onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>✕</button>
    </div>
  )
}
