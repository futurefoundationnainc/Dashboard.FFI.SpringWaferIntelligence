import type { Theme } from '../../theme/useTheme'

interface Props {
  editorHref: string
  loading: boolean
  onReload: () => void
  theme: Theme
  onToggleTheme: () => void
}

/* The Wafer Map page's only chrome: a slim right-aligned bar of page actions. */
export function WaferToolbar({ editorHref, loading, onReload, theme, onToggleTheme }: Props) {
  return (
    <div className="wafer-toolbar" role="toolbar" aria-label="Page actions">
      <a className="btn btn-sm" href={editorHref} data-testid="open-editor-small">Layout Editor</a>
      <button type="button" className="btn btn-sm icon-btn" disabled={loading} onClick={onReload} aria-label="Reload" title="Reload">
        <span aria-hidden="true" className={loading ? 'spin-icon' : undefined}>↻</span>
      </button>
      <button
        type="button"
        className="btn btn-sm icon-btn"
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        onClick={onToggleTheme}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </div>
  )
}
