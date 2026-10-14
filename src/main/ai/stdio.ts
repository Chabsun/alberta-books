/**
 * `AlbertaBooks.exe --mcp-stdio`: lets Claude Desktop (which talks to MCP
 * servers over stdin/stdout) use the running app. Each JSON-RPC line read on
 * stdin is forwarded to the app's local server with the personal token from
 * ALBERTA_BOOKS_TOKEN; replies are written to stdout, one per line.
 *
 * If the app isn't running, it is started once and the request retried.
 * Nothing else is ever written to stdout (it would corrupt the protocol).
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export interface BridgeOptions {
  input: Readable
  output: Writable
  /** Where the app's server listens, read fresh each time (the port can change when the app restarts). */
  serverUrl: () => string
  token: string
  /** Starts the desktop app. */
  launchApp: () => void
  /** For diagnostics (stderr). */
  log: (message: string) => void
  startupTimeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function idOf(line: string): string | number | null | undefined {
  try {
    const m = JSON.parse(line) as { id?: string | number | null; method?: string }
    return Array.isArray(m) ? null : m.id
  } catch {
    return null
  }
}

export function runStdioBridge(opts: BridgeOptions): Promise<void> {
  let launched = false
  const write = (obj: unknown) => opts.output.write(`${JSON.stringify(obj)}\n`)

  async function post(line: string): Promise<{ status: number; body: string }> {
    const deadline = Date.now() + (opts.startupTimeoutMs ?? 30_000)
    for (;;) {
      try {
        const res = await fetch(`${opts.serverUrl()}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${opts.token}` },
          body: line
        })
        return { status: res.status, body: await res.text() }
      } catch (err) {
        // Not running yet: start the app once, then keep trying until it is up.
        if (!launched) {
          launched = true
          opts.log('Alberta Books is not running; starting it.')
          opts.launchApp()
        }
        if (Date.now() > deadline) throw err
        await sleep(500)
      }
    }
  }

  async function handle(line: string): Promise<void> {
    const id = idOf(line)
    try {
      const { status, body } = await post(line)
      if (status === 202 || (status === 200 && body === '')) return
      if (status === 200) {
        opts.output.write(`${body.replace(/\r?\n/g, '')}\n`)
        return
      }
      const reason =
        status === 401
          ? 'Alberta Books rejected the token. Create a new one in Alberta Books → Settings → AI assistants and update ALBERTA_BOOKS_TOKEN.'
          : `Alberta Books answered with HTTP ${status}.`
      opts.log(reason)
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32001, message: reason } })
    } catch {
      const reason = 'Could not reach Alberta Books. Open the app and turn on AI assistants in Settings.'
      opts.log(reason)
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32002, message: reason } })
    }
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: opts.input, crlfDelay: Infinity })
    // Replies must keep request order for clients that expect it; process one line at a time.
    let chain = Promise.resolve()
    rl.on('line', (raw) => {
      const line = raw.trim()
      if (!line) return
      chain = chain.then(() => handle(line))
    })
    rl.on('close', () => void chain.then(() => resolve()))
  })
}
