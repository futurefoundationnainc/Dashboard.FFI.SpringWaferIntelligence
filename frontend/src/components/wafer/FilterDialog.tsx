import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { FilterDefinition, FilterRule, SavedMapFilter, SavedMapFilterDetail, WaferMap } from '../../api/types'
import { readAuthor, rememberAuthor } from '../../authorName'
import { fmt } from '../../format'
import { unitWord } from '../../terms'
import { FilterRuleRow } from './FilterRuleRow'
import { describeDefinition, emptyRule, filterMask, ruleProblem } from './mapFilter'

/* What the page applies: a saved filter (id + revision) or an unsaved draft. */
export interface AppliedFilter {
  id: string | null
  name: string
  revision: number | null
  definition: FilterDefinition
}

interface Props {
  data: WaferMap
  active: AppliedFilter | null
  onApply: (filter: AppliedFilter) => void
  onClose: () => void
}

interface Draft {
  id: string | null
  name: string
  definition: FilterDefinition
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function when(value: string): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

const NEW_DRAFT: Draft = { id: null, name: '', definition: { match: 'all', rules: [emptyRule()] } }

/* The map filter builder: the shared library on the left (apply, edit, copy,
   hide / bring back, revision history), the rule builder on the right with a
   live count on the current wafer. Saving an existing filter adds a revision. */
export function FilterDialog({ data, active, onApply, onClose }: Props) {
  const [library, setLibrary] = useState<SavedMapFilter[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => (active ? { id: active.id, name: active.name, definition: active.definition } : NEW_DRAFT))
  const [history, setHistory] = useState<SavedMapFilterDetail | null>(null)
  const [author, setAuthor] = useState(readAuthor)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLibrary((await api.mapFilters()).filters)
    } catch (err) {
      setError(`Could not load saved filters: ${errorText(err)}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadHistory = useCallback(async (id: string | null) => {
    setHistory(id ? await api.mapFilter(id).catch(() => null) : null)
  }, [])

  useEffect(() => {
    void loadHistory(draft.id)
  }, [draft.id, loadHistory])

  const rules = draft.definition.rules
  const problems = rules.map(ruleProblem)
  const valid = rules.length > 0 && problems.every((p) => p === null)
  const preview = useMemo(() => {
    if (!valid) return null
    const mask = filterMask(draft.definition, data)
    if (!mask) return null
    return { matched: mask.filter(Boolean).length, total: mask.length }
  }, [draft.definition, data, valid])
  const unit = unitWord(data.summary.unit, data.feature_label)

  const setRules = (next: FilterRule[]) => setDraft((d) => ({ ...d, definition: { ...d.definition, rules: next } }))
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const save = (asNew: boolean) => run(async () => {
    rememberAuthor(author)
    const saved = draft.id && !asNew
      ? await api.saveMapFilter(draft.id, draft.name.trim(), draft.definition, author.trim(), note.trim())
      : await api.createMapFilter(draft.name.trim(), draft.definition, author.trim(), note.trim())
    setDraft({ id: saved.id, name: saved.name, definition: saved.definition })
    setNote('')
    setMessage(`Saved ${saved.name} · revision ${saved.revision}.`)
    await refresh()
    await loadHistory(saved.id)
  })

  const copy = (f: SavedMapFilter) => run(async () => {
    let created: SavedMapFilter | null = null
    for (let n = 1; n <= 9 && !created; n++) {
      const name = `${f.name} copy${n > 1 ? ` ${n}` : ''}`.slice(0, 80)
      created = await api.copyMapFilter(f.id, name, author.trim()).catch((err: unknown) => {
        if (n === 9 || !errorText(err).includes('already exists')) throw err
        return null
      })
    }
    if (created) {
      setDraft({ id: created.id, name: created.name, definition: created.definition })
      setMessage(`Copied as ${created.name}. Rename it and save to make it your own.`)
    }
    await refresh()
  })

  const setHidden = (f: SavedMapFilter, hidden: boolean) => run(async () => {
    await api.setMapFilterHidden(f.id, hidden, author.trim())
    setMessage(hidden ? `${f.name} is hidden; tick "Show hidden" to bring it back.` : `${f.name} is back.`)
    await refresh()
  })

  const restore = (rev: number) => run(async () => {
    if (!draft.id) return
    const saved = await api.restoreMapFilter(draft.id, rev, author.trim())
    setDraft({ id: saved.id, name: saved.name, definition: saved.definition })
    setMessage(`Revision ${rev} restored as revision ${saved.revision}.`)
    await refresh()
    await loadHistory(saved.id)
  })

  const apply = () => {
    const saved = draft.id ? library.find((f) => f.id === draft.id) : null
    const unchanged = saved && JSON.stringify(saved.definition) === JSON.stringify(draft.definition)
    onApply({
      id: unchanged ? saved.id : null,
      name: draft.name.trim() || 'Unsaved filter',
      revision: unchanged ? saved.revision : null,
      definition: draft.definition,
    })
  }

  const visible = library.filter((f) => showHidden || !f.hidden)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal filter-dialog" role="dialog" aria-modal="true" aria-label="Map filters">
        <div className="card-header">
          <h2 className="card-title">Map filters</h2>
          <button type="button" className="btn btn-sm icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <div className="error-banner" role="alert" data-testid="filter-error">{error}</div>}
        {message && <div className="warning-banner" role="status" style={{ borderLeftColor: 'var(--good)' }}>✓ {message}</div>}

        <div className="filter-dialog-body">
          <section className="filter-library" aria-label="Saved filters">
            <div className="status-list-head">
              <span className="micro-label">Saved filters (shared)</span>
              <button type="button" className="link-btn" onClick={() => { setDraft(NEW_DRAFT); setNote('') }}>+ New</button>
            </div>
            <label className="checkbox-row" style={{ margin: '4px 0' }}>
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Show hidden
            </label>
            <ul className="filter-list" data-testid="saved-filters">
              {visible.length === 0 && <li className="cell-muted">No saved filters yet.</li>}
              {visible.map((f) => (
                <li key={f.id} className={`filter-item ${f.id === draft.id ? 'is-current' : ''} ${f.hidden ? 'row-hidden' : ''}`}>
                  <button type="button" className="filter-item-main" onClick={() => { setDraft({ id: f.id, name: f.name, definition: f.definition }); setNote('') }} title="Edit this filter">
                    <strong>{f.name}</strong> <span className="cell-muted">rev {f.revision}{f.hidden ? ' · hidden' : ''}</span>
                    <span className="filter-item-desc">{describeDefinition(f.definition)}</span>
                  </button>
                  <span className="card-actions">
                    {!f.hidden && (
                      <button type="button" className="btn btn-sm" disabled={busy} data-testid={`apply-${f.name}`}
                        onClick={() => onApply({ id: f.id, name: f.name, revision: f.revision, definition: f.definition })}>Apply</button>
                    )}
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void copy(f)}>Copy</button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void setHidden(f, !f.hidden)}>{f.hidden ? 'Bring back' : 'Hide'}</button>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="filter-builder" aria-label="Filter builder">
            <div className="field">
              <label className="field-label" htmlFor="filter-name">Name</label>
              <input id="filter-name" className="input" type="text" value={draft.name} placeholder="e.g. Defects before stage 4900"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="filter-match" role="radiogroup" aria-label="Match">
              Show {unit} that match
              <label><input type="radio" name="match" checked={draft.definition.match === 'all'} onChange={() => setDraft((d) => ({ ...d, definition: { ...d.definition, match: 'all' } }))} /> all rules</label>
              <label><input type="radio" name="match" checked={draft.definition.match === 'any'} onChange={() => setDraft((d) => ({ ...d, definition: { ...d.definition, match: 'any' } }))} /> any rule</label>
            </div>
            <div className="filter-rules">
              {rules.map((rule, i) => (
                <FilterRuleRow
                  key={i}
                  rule={rule}
                  index={i}
                  onChange={(next) => setRules(rules.map((r, j) => (j === i ? next : r)))}
                  onRemove={() => setRules(rules.filter((_r, j) => j !== i))}
                />
              ))}
              <button type="button" className="btn btn-sm" onClick={() => setRules([...rules, emptyRule()])} data-testid="add-rule">+ Add rule</button>
            </div>
            <div className="filter-preview" data-testid="filter-preview">
              {preview
                ? `Matches ${fmt(preview.matched)} of ${fmt(preview.total)} ${unit} on this wafer.`
                : rules.length === 0 ? 'Add a rule.' : (problems.find(Boolean) ?? '')}
            </div>
            <div className="two-col">
              <div className="field">
                <label className="field-label" htmlFor="filter-author">Your name</label>
                <input id="filter-author" className="input" type="text" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Shown in the revision history" />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="filter-note">Note (optional)</label>
                <input id="filter-note" className="input" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this revision changes" />
              </div>
            </div>
            <div className="editor-toolbar">
              <button type="button" className="btn btn-accent" disabled={!valid || busy} onClick={apply} data-testid="apply-draft">Apply to map</button>
              <button type="button" className="btn" disabled={!valid || busy || !draft.name.trim()} onClick={() => void save(false)} data-testid="save-filter">
                {draft.id ? 'Save as new revision' : 'Save'}
              </button>
              {draft.id && (
                <button type="button" className="btn" disabled={!valid || busy || !draft.name.trim()} onClick={() => void save(true)}>Save as new filter</button>
              )}
            </div>

            {history && history.revisions.length > 0 && (
              <details className="filter-history">
                <summary className="micro-label">Revision history ({history.revisions.length})</summary>
                <table data-testid="filter-revisions">
                  <thead><tr><th>Rev</th><th>Saved</th><th>By</th><th>Rules</th><th></th></tr></thead>
                  <tbody>
                    {history.revisions.map((r) => (
                      <tr key={r.rev}>
                        <td>{r.rev}{r.rev === history.revision && <span className="cell-muted"> (current)</span>}</td>
                        <td className="cell-muted">{when(r.saved_at)}</td>
                        <td>{r.author || '—'}</td>
                        <td>{describeDefinition(r.definition)}{r.note ? <span className="cell-muted"> · {r.note}</span> : null}</td>
                        <td>{r.rev !== history.revision && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void restore(r.rev)}>Restore</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
