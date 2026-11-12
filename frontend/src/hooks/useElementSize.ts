import { useCallback, useEffect, useState } from 'react'

export interface Size {
  width: number
  height: number
}

/* The content-box size of an element, kept current with a ResizeObserver
   (window resizes, sidebar changes). `null` until measured.

   Returns a *callback* ref: the element often mounts later than the component
   (e.g. only after data has loaded), and a callback ref re-attaches the
   observer whenever the element appears or is replaced. */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, Size | null] {
  const [node, setNode] = useState<T | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  const ref = useCallback((el: T | null) => setNode(el), [])

  useEffect(() => {
    if (!node) return
    const update = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) }
      if (next.width === 0 && next.height === 0) return // not laid out (jsdom, display:none)
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next))
    }
    // Measure now: ResizeObserver only reports on the next rendered frame, which a
    // background tab may not produce until it is shown. (Elements measured here have no padding.)
    const rect = node.getBoundingClientRect()
    update(rect.width, rect.height)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) update(box.width, box.height)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return [ref, size]
}
