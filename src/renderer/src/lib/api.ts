import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BooksBridge, Input, Method, Output } from '../../../shared/api'

declare global {
  interface Window {
    books: BooksBridge
  }
}

export class ApiError extends Error {}

/** Calls an operation in the main process. Throws ApiError with a readable message on failure. */
export async function call<M extends Method>(method: M, ...input: undefined extends Input<M> ? [Input<M>?] : [Input<M>]): Promise<Output<M>> {
  const res = await window.books.call(method, input[0])
  if (!res.ok) throw new ApiError(res.error)
  return res.data as Output<M>
}

// Every successful change bumps a version number, and every query refetches.
// The books are small and local, so refetching is instant and never stale.
let version = 0
const listeners = new Set<() => void>()

export function invalidate(): void {
  version++
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Like `call`, then refreshes every screen's data. */
export async function mutate<M extends Method>(method: M, ...input: undefined extends Input<M> ? [Input<M>?] : [Input<M>]): Promise<Output<M>> {
  const result = await call(method, ...input)
  invalidate()
  return result
}

export interface QueryState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
}

export function useQuery<M extends Method>(method: M, input?: Input<M>, enabled = true): QueryState<Output<M>> {
  const v = useSyncExternalStore(subscribe, () => version)
  const key = JSON.stringify(input ?? null)
  const [state, setState] = useState<QueryState<Output<M>>>({ data: undefined, error: null, loading: enabled })

  useEffect(() => {
    if (!enabled) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    window.books
      .call(method, input)
      .then((res) => {
        if (!alive) return
        if (res.ok) setState({ data: res.data as Output<M>, error: null, loading: false })
        else setState((s) => ({ data: s.data, error: res.error, loading: false }))
      })
      .catch((e: unknown) => alive && setState((s) => ({ data: s.data, error: String(e), loading: false })))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, key, v, enabled])

  return state
}
