/**
 * The single IPC entry point. For every request it:
 *  1. checks the request comes from the app's own page (not any other frame),
 *  2. checks the operation is on the allow-list,
 *  3. validates the input with the operation's schema,
 *  4. runs the handler and returns { ok, data } or { ok: false, error }.
 * Unexpected errors are logged; the UI gets a generic message, never internals.
 */
import { ipcMain } from 'electron'
import { schemas, type Method, type RpcResult } from '../shared/api'
import type { AppContext } from './context'
import { userMessage } from './errors'
import { handlers } from './handlers'
import { logError } from './log'

export function registerIpc(getCtx: () => AppContext, isTrustedUrl: (url: string) => boolean): void {
  ipcMain.handle('rpc', async (event, method: unknown, input: unknown): Promise<RpcResult<unknown>> => {
    const frameUrl = event.senderFrame?.url ?? ''
    if (!isTrustedUrl(frameUrl) || event.senderFrame?.parent) {
      logError('ipc', `Rejected request from untrusted frame ${frameUrl}`)
      return { ok: false, error: 'Request rejected.' }
    }
    if (typeof method !== 'string' || !Object.hasOwn(schemas, method)) {
      return { ok: false, error: 'Unknown operation.' }
    }
    const m = method as Method
    const parsed = schemas[m].safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Some of the information entered is not valid.' }
    }
    try {
      const handler = handlers[m] as (i: unknown, c: AppContext) => unknown
      const data = await handler(parsed.data, getCtx())
      return { ok: true, data: data ?? null }
    } catch (err) {
      const message = userMessage(err)
      if (message) return { ok: false, error: message }
      logError(m, err)
      return { ok: false, error: 'Something went wrong and nothing was saved. Details are in the log file.' }
    }
  })
}
