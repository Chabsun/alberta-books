import { useSyncExternalStore } from 'react'

/** Tiny hash router: '#/invoices/12' -> '/invoices/12'. */
function current(): string {
  const h = window.location.hash.replace(/^#/, '')
  return h.startsWith('/') ? h : '/'
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, current)
}

export function navigate(path: string): void {
  if (current() !== path) window.location.hash = path
}

/** Matches '/invoices/:id' against a path and returns the params, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/')
  const a = path.split('?')[0].split('/')
  if (p.length !== a.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return params
}

export function queryParam(path: string, name: string): string | null {
  const q = path.split('?')[1]
  return q ? new URLSearchParams(q).get(name) : null
}
