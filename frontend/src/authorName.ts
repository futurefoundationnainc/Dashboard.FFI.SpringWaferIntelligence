/* The name people type into the editors ("shown in the revision history"),
   remembered per browser. Shared by the Layout Editor and the map filters.
   Storage can be unavailable (private window): then it is simply not remembered. */

const AUTHOR_KEY = 'wafermap.layoutAuthor'

export function readAuthor(): string {
  try {
    return window.localStorage.getItem(AUTHOR_KEY) ?? ''
  } catch {
    return ''
  }
}

export function rememberAuthor(value: string): void {
  try {
    window.localStorage.setItem(AUTHOR_KEY, value)
  } catch {
    /* not remembered */
  }
}
