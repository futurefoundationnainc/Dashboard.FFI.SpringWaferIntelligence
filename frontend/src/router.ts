import { useEffect, useState } from 'react'

/* Hash routing keeps the single-origin deployed shape working (FastAPI only
   serves index.html at "/"), so pages are "#/" (workbench) and "#/layouts".
   The dashboards' wafer-map icon opens "?sample=<id>&plan=2d|3d" (no hash):
   that is the single-wafer Wafer Map page. "#/editor" is the standalone
   Layout Editor (production); "#/layouts" is the prototype's layouts page.
   Hash routes always win, so the editor can be opened from a wafer page
   without losing its query. */
export type Route = 'map' | 'layouts' | 'wafer' | 'editor'

export const ROUTE_HASH: Record<Route, string> = { map: '#/', layouts: '#/layouts', wafer: '#/', editor: '#/editor' }

export function routeFromHash(hash: string, search: string = ''): Route {
  const page = hash.replace(/^#\/?/, '').split('?')[0]
  if (page === 'layouts') return 'layouts'
  if (page === 'editor') return 'editor'
  return new URLSearchParams(search).get('sample') ? 'wafer' : 'map'
}

/* Query parameters carried inside the hash, e.g. "#/layouts?product=X&group=Y". */
export function hashParams(hash: string = window.location.hash): URLSearchParams {
  const q = hash.indexOf('?')
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '')
}

/* The (standalone) Layout Editor URL for a product / group, remembering the page to come back to. */
export function layoutEditorHash(product: string, group: string, returnTo: string): string {
  const params = new URLSearchParams()
  if (product) params.set('product', product)
  if (group) params.set('group', group)
  if (returnTo) params.set('return', returnTo)
  const query = params.toString()
  return query ? `#/editor?${query}` : '#/editor'
}

/* Only same-page query strings are honored as "return" targets (never another origin). */
export function safeReturn(value: string | null): string | null {
  return value && /^\?[A-Za-z0-9_.~%=&+-]*$/.test(value) ? value : null
}

export function navigate(route: Route): void {
  window.location.hash = ROUTE_HASH[route]
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash, window.location.search))
  useEffect(() => {
    const onChange = () => setRoute(routeFromHash(window.location.hash, window.location.search))
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, [])
  return route
}
