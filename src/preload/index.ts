/**
 * Preload: the only bridge between the UI and the main process.
 * It exposes `books.call(method, input)` and `books.onChanged(fn)` (the books
 * changed outside the window, e.g. by an AI assistant). It does not
 * expose ipcRenderer, Node.js or any file access. The main process checks
 * every call against its allow-list and validates the input.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { BooksBridge, RpcResult } from '../shared/api'

const bridge: BooksBridge = {
  platform: process.platform,
  call: (method: string, input: unknown): Promise<RpcResult<unknown>> => {
    if (typeof method !== 'string') return Promise.resolve({ ok: false, error: 'Invalid operation.' })
    return ipcRenderer.invoke('rpc', method, input)
  },
  onChanged: (fn: () => void) => {
    const listener = () => fn()
    ipcRenderer.on('books:changed', listener)
    return () => void ipcRenderer.off('books:changed', listener)
  }
}

contextBridge.exposeInMainWorld('books', bridge)
