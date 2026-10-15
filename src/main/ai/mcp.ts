/**
 * Model Context Protocol (JSON-RPC 2.0) for one authenticated connection:
 * initialize, ping, tools/list and tools/call. No sampling, no prompts, no
 * resources: an assistant can only call the tools in tools.ts.
 */
import { userMessage } from '../errors'
import { logError } from '../log'
import { callTool, describeTools, type ToolContext } from './tools'

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const SERVER_INFO = { name: 'alberta-books', title: 'Alberta Books', version: '1.0.0' }

const INSTRUCTIONS = `Bookkeeping for a one-person Alberta corporation (GST 5%, no PST; dividends only, no payroll).
Call get_overview first, and get_cra_expense_rules before categorizing expenses.
Amounts are dollars as strings ("42.50"). Positive bank amounts are money in.
Never guess a business purpose, attendees or GST number: ask the user.
Final actions (issue or void invoices, change settings, file GST, restore a backup, delete) only when the user asks for that specific action.
Posted entries are never edited; mistakes are fixed by reversing (undo_bank_categorization, reverse_journal_entry).`

const ACCESS = { read: 'read only', write: 'read and make changes', full: 'full control (final actions are confirmed by the user in the app unless they turned that off)' }

type Id = string | number | null

interface Request {
  jsonrpc: '2.0'
  id?: Id
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = { jsonrpc: '2.0'; id: Id } & ({ result: unknown } | { error: { code: number; message: string } })

const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
const fail = (id: Id, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })

function isRequest(m: unknown): m is Request {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  return r.jsonrpc === '2.0' && typeof r.method === 'string' && (r.params === undefined || (typeof r.params === 'object' && r.params !== null))
}

/** Handles one JSON-RPC message. Returns null for notifications (no reply). */
export async function handleMessage(message: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    const id = message && typeof message === 'object' && 'id' in message ? ((message as { id: Id }).id ?? null) : null
    return fail(id, -32600, 'Invalid request')
  }
  const isNotification = !('id' in message) || message.id === undefined
  const id: Id = isNotification ? null : (message.id as Id)
  if (isNotification) return null

  switch (message.method) {
    case 'initialize': {
      const asked = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : ''
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `${INSTRUCTIONS}\nThis connection is ${ACCESS[ctx.connection.mode]}.`
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: describeTools(ctx.connection.mode) })
    case 'tools/call': {
      const name = message.params?.name
      if (typeof name !== 'string') return fail(id, -32602, 'Missing tool name')
      try {
        const { data, files } = await callTool(name, message.params?.arguments, ctx)
        const content: unknown[] = [{ type: 'text', text: JSON.stringify(data, null, 1) }]
        // Files (an invoice PDF) go back as embedded resources the assistant can attach or show.
        for (const f of files) {
          content.push({
            type: 'resource',
            resource: { uri: `books://files/${encodeURIComponent(f.fileName)}`, mimeType: f.mime, blob: Buffer.from(f.bytes).toString('base64') }
          })
        }
        return ok(id, { content, isError: false })
      } catch (err) {
        const text = userMessage(err)
        if (!text) logError(`mcp:${name}`, err)
        // Tool errors go back to the model so it can correct itself.
        return ok(id, { content: [{ type: 'text', text: text ?? 'The operation failed. Nothing was saved.' }], isError: true })
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${message.method}`)
  }
}
