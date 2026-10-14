/**
 * Preload: the only bridge between the UI and the main process.
 * It exposes exactly one function, `books.call(method, input)`. It does not
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
  }
}

contextBridge.exposeInMainWorld('books', bridge)
