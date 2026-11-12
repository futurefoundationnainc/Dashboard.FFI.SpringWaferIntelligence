import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { WaferMap } from '../api/types'

export interface WaferMapState {
  data: WaferMap | null
  error: string | null
  loading: boolean
  reload: () => void
}

/* Loads one sample's wafer map from the API. Only data fetching lives here;
   the page and its components only render what this returns. A response for an
   older request (sample changed mid-flight) is dropped. */
export function useWaferMap(sample: string, plan: string | null): WaferMapState {
  const [data, setData] = useState<WaferMap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!sample) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api.waferMap(sample, plan)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setData(null)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sample, plan, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}
