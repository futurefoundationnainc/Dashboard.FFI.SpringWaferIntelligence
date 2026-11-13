import '@testing-library/jest-dom'

/* jsdom lacks ResizeObserver; Plotly's responsive config asks for it. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}

/* jsdom has no URL.createObjectURL; the export buttons call it for downloads. */
if (!('createObjectURL' in URL)) {
  ;(URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:test'
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}
}

/* jsdom does not implement scrolling; App scrolls to the top on page changes. */
window.scrollTo = (() => {}) as typeof window.scrollTo
