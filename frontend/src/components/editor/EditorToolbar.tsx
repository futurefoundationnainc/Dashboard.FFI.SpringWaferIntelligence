import type { Theme } from '../../theme/useTheme'

interface Props {
  backToWafer: string | null
  author: string
  onAuthor: (value: string) => void
  theme: Theme
  onToggleTheme: () => void
}

/* The Layout Editor's chrome: its name, who is editing (saved with every
   revision), the way back to the wafer it was opened from, and the theme. */
export function EditorToolbar({ backToWafer, author, onAuthor, theme, onToggleTheme }: Props) {
  return (
    <div className="wafer-toolbar editor-topbar" role="toolbar" aria-label="Editor actions">
      <h1 className="app-title editor-title">Layout Editor</h1>
      <span className="header-spacer" />
      <label className="editor-author">
        Editing as
        <input className="input" type="text" value={author} onChange={(e) => onAuthor(e.target.value)} placeholder="your name" aria-label="Your name" />
      </label>
      {backToWafer && <a className="btn btn-sm" href={backToWafer} data-testid="back-to-wafer">← Back to wafer map</a>}
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
