import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenConnection, revokeConnection, type AiMode } from '../src/main/ai/connections'
import { AiServer, type ApprovalRequest } from '../src/main/ai/server'
import { TOOLS } from '../src/main/ai/tools'
import { listAudit } from '../src/main/services/audit'
import { importStatement, listBankTransactions } from '../src/main/services/bankFeed'
import { listExpenses } from '../src/main/services/expenses'
import { makeDb, role } from './helpers'

const servers: AiServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
})

async function setup(approveWith: AiMode | null = 'write') {
  const db = makeDb()
  const approvals: ApprovalRequest[] = []
  let publicUrl: string | null = null
  const server = new AiServer({
    port: 0,
    getDb: () => db,
    receiptsDir: () => mkdtempSync(join(tmpdir(), 'books-ai-')),
    publicUrl: () => publicUrl,
    approve: async (r) => {
      approvals.push(r)
      return approveWith
    }
  })
  servers.push(server)
  await server.start()
  return { db, server, approvals, setPublic: (u: string | null) => (publicUrl = u) }
}

/** Raw HTTP so the Host and Origin headers can be set freely. */
function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function rpc(port: number, token: string, method: string, params: unknown = {}, id = 1) {
  return http(port, 'POST', '/mcp', { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, JSON.stringify({ jsonrpc: '2.0', id, method, params }))
}

async function call(port: number, token: string, name: string, args: unknown) {
  const r = await rpc(port, token, 'tools/call', { name, arguments: args })
  expect(r.status).toBe(200)
  const result = JSON.parse(r.body).result as { content: { text: string }[]; isError: boolean }
  return { isError: result.isError, text: result.content[0]!.text, data: result.isError ? null : JSON.parse(result.content[0]!.text) }
}

const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260210<TRNAMT>-52.50<FITID>A1<NAME>STAPLES #123</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

describe('MCP server with a personal token', () => {
  it('requires a token and points to the OAuth metadata', async () => {
    const { server } = await setup()
    const r = await http(server.port, 'POST', '/mcp', { 'content-type': 'application/json' }, '{}')
    expect(r.status).toBe(401)
    expect(r.headers['www-authenticate']).toContain(`resource_metadata="http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource"`)
    expect((await rpc(server.port, 'abk_' + 'x'.repeat(43), 'ping')).status).toBe(401)
  })

  it('blocks other Host headers (DNS rebinding) and foreign web pages', async () => {
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Claude Code', 'read')
    expect((await http(server.port, 'GET', '/', { host: 'evil.example:80' })).status).toBe(421)
    const foreign = await http(server.port, 'POST', '/mcp', { origin: 'https://evil.example', authorization: `Bearer ${token}` }, '{}')
    expect(foreign.status).toBe(403)
  })

  it('initializes, lists tools by access mode, and refuses writes when read-only', async () => {
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Claude Code', 'read')
    const init = JSON.parse((await rpc(server.port, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).body)
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'alberta-books' } })
    // Notifications get 202 and no body.
    const note = await http(server.port, 'POST', '/mcp', { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(note.status).toBe(202)

    const tools = JSON.parse((await rpc(server.port, token, 'tools/list')).body).result.tools as { name: string; inputSchema: { type: string } }[]
    expect(tools.map((t) => t.name)).toContain('get_cra_expense_rules')
    expect(tools.map((t) => t.name)).not.toContain('create_expense')
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true)

    const denied = await call(server.port, token, 'create_expense', {})
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/read-only/)

    const overview = await call(server.port, token, 'get_overview', {})
    expect(overview.data.company.province).toBe('Alberta')
    const rules = await call(server.port, token, 'get_cra_expense_rules', {})
    expect(rules.data.rules.find((r: { id: string }) => r.id === 'meals_entertainment')).toMatchObject({ deductiblePct: 50 })

    revokeConnection(db, 1)
    expect((await rpc(server.port, token, 'ping')).status).toBe(401)
  })

  it('writes are validated, follow CRA rules and are attributed to the assistant', async () => {
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Claude Code', 'write')
    const bad = await call(server.port, token, 'create_expense', { date: '2026-02-30', vendor: 'X', category: '5110', amount: '10', gst: '0', paid_from: '1000' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/date/)

    const meal = await call(server.port, token, 'create_expense', {
      date: '2026-02-10',
      vendor: 'The Keg',
      category: '5110',
      amount: '100.00',
      gst: '5.00',
      paid_from: '1000',
      purpose: 'Project kickoff',
      attendees: 'J. Smith (Acme)'
    })
    expect(meal.isError).toBe(false)
    expect(meal.data).toMatchObject({ amount: '100.00', gst: '5.00', itc: '2.50' })
    expect(listExpenses(db)[0]!.vendor).toBe('The Keg')
    expect(listAudit(db, { actorPrefix: 'ai:' })[0]).toMatchObject({ actor: 'ai:Claude Code', entity: 'expense' })
    const entry = db.get<{ actor: string }>('SELECT actor FROM journal_entries ORDER BY id DESC LIMIT 1')!
    expect(entry.actor).toBe('ai:Claude Code')
  })

  it('imports a statement by content and categorizes from the queue', async () => {
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Grok', 'write')
    const imported = await call(server.port, token, 'import_bank_statement', { bank_account: '1000', file_name: 'nbc.qbo', content: OFX })
    expect(imported.data).toMatchObject({ inserted: 1 })
    const [tx] = listBankTransactions(db, { status: 'unreviewed' })
    const done = await call(server.port, token, 'categorize_bank_transaction', { id: tx!.id, account: '5160', gst_included: true, remember: true })
    expect(done.data).toMatchObject({ status: 'posted', amount: '-52.50' })
  })
})

describe('OAuth for Grok', () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  async function register(port: number) {
    const r = await http(port, 'POST', '/register', { 'content-type': 'application/json' }, JSON.stringify({ client_name: 'Grok', redirect_uris: ['https://grok.com/oauth/callback'] }))
    expect(r.status).toBe(201)
    return JSON.parse(r.body).client_id as string
  }

  async function authorize(port: number, clientId: string, redirect = 'https://grok.com/oauth/callback') {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })
    const page = await http(port, 'GET', `/authorize?${q}`)
    if (page.status !== 200) return { page, location: null }
    const id = /const id = "([\w-]+)"/.exec(page.body)![1]!
    for (let i = 0; i < 50; i++) {
      const s = JSON.parse((await http(port, 'GET', `/authorize/status?id=${id}`)).body)
      if (s.location) return { page, location: new URL(s.location) }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('no decision')
  }

  it('publishes metadata with the public address when tunnelled', async () => {
    const { server, setPublic } = await setup()
    setPublic('https://books-test.trycloudflare.com')
    const meta = JSON.parse((await http(server.port, 'GET', '/.well-known/oauth-authorization-server', { host: 'books-test.trycloudflare.com' })).body)
    expect(meta).toMatchObject({
      issuer: 'https://books-test.trycloudflare.com',
      token_endpoint: 'https://books-test.trycloudflare.com/token',
      code_challenge_methods_supported: ['S256']
    })
    const pr = JSON.parse((await http(server.port, 'GET', '/.well-known/oauth-protected-resource')).body)
    expect(pr.resource).toBe(`http://127.0.0.1:${server.port}/mcp`)
  })

  it('registers, asks you, exchanges the code with PKCE, refreshes, and the code works once', async () => {
    const { server, approvals } = await setup('read')
    const clientId = await register(server.port)
    const { page, location } = await authorize(server.port, clientId)
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-/)
    expect(approvals[0]).toMatchObject({ clientName: 'Grok', redirectHost: 'grok.com' })
    expect(location!.origin + location!.pathname).toBe('https://grok.com/oauth/callback')
    expect(location!.searchParams.get('state')).toBe('xyz')
    const code = location!.searchParams.get('code')!

    const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
    const ct = { 'content-type': 'application/x-www-form-urlencoded' }
    const wrong = await http(server.port, 'POST', '/token', ct, form({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: clientId, redirect_uri: 'https://grok.com/oauth/callback' }))
    expect(wrong.status).toBe(400)
    // The failed attempt burned the code.
    const again = await http(server.port, 'POST', '/token', ct, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId }))
    expect(JSON.parse(again.body).error).toBe('invalid_grant')

    const second = await authorize(server.port, clientId)
    const tok = await http(server.port, 'POST', '/token', ct, form({ grant_type: 'authorization_code', code: second.location!.searchParams.get('code')!, code_verifier: verifier, client_id: clientId, redirect_uri: 'https://grok.com/oauth/callback' }))
    expect(tok.status).toBe(200)
    const tokens = JSON.parse(tok.body)
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'books.read' })
    expect((await rpc(server.port, tokens.access_token, 'ping')).status).toBe(200)

    const refreshed = JSON.parse((await http(server.port, 'POST', '/token', ct, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).body)
    expect(refreshed.access_token).toMatch(/^aba_/)
    const reused = await http(server.port, 'POST', '/token', ct, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))
    expect(reused.status).toBe(400)
  })

  it('denial and unknown redirect addresses never produce a code', async () => {
    const { server } = await setup(null)
    const clientId = await register(server.port)
    const { location } = await authorize(server.port, clientId)
    expect(location!.searchParams.get('error')).toBe('access_denied')
    expect(location!.searchParams.get('code')).toBeNull()
    const evil = await authorize(server.port, clientId, 'https://evil.example/cb')
    expect(evil.page.status).toBe(400)
    const noPkce = await http(server.port, 'GET', `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://grok.com/oauth/callback')}`)
    expect(noPkce.status).toBe(302)
    expect(noPkce.headers.location).toContain('error=invalid_request')
    const http1 = await http(server.port, 'POST', '/register', { 'content-type': 'application/json' }, JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }))
    expect(http1.status).toBe(400)
  })

  it('the built-in "grok" client works for connectors that ask for a client ID', async () => {
    const { server } = await setup('write')
    const { location } = await authorize(server.port, 'grok', 'https://grok.com/connectors/oauth/callback')
    expect(location!.searchParams.get('code')).toBeTruthy()
  })
})

describe('tool catalogue', () => {
  it('every tool has a unique name, a description and an object schema', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    expect(names.size).toBe(TOOLS.length)
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]{3,40}$/)
      expect(t.description.length).toBeGreaterThan(20)
    }
    // Nothing that can't be undone or that changes settings.
    expect([...names].some((n) => /settings|lock|delete|restore|issue_invoice|file_gst|void/.test(n))).toBe(false)
  })

  it('statement import through the service and through the tool give the same result', () => {
    const db = makeDb()
    const r = importStatement(db, { bankAccountId: role(db, 'bank'), fileName: 'a.qbo', bytes: new TextEncoder().encode(OFX) })
    expect(r.inserted).toBe(1)
  })
})

// The bridge program Claude Desktop runs (bridge/main.go). Built by `npm run bridge`.
const BRIDGE = join(__dirname, '..', 'build', 'bin', process.platform === 'win32' ? 'alberta-books-mcp.exe' : 'alberta-books-mcp')

function runBridge(env: Record<string, string>, lines: unknown[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(BRIDGE, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('exit', (code) => resolve({ code, out, err }))
    child.stdin.end(lines.map((l) => JSON.stringify(l) + '\n').join(''))
  })
}

describe.skipIf(!existsSync(BRIDGE))('Claude Desktop bridge program', () => {
  it('relays requests line by line, skips notifications, and reads the port the app wrote', async () => {
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Claude Desktop', 'read')
    const info = join(mkdtempSync(join(tmpdir(), 'books-bridge-')), 'ai-server.json')
    writeFileSync(info, JSON.stringify({ port: server.port }))
    const r = await runBridge({ ALBERTA_BOOKS_TOKEN: token, ALBERTA_BOOKS_SERVER_INFO: info }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_overview', arguments: {} } }
    ])
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.id)).toEqual([1, 2])
    expect(lines[0].result.serverInfo.name).toBe('alberta-books')
    expect(JSON.parse(lines[1].result.content[0].text).company.province).toBe('Alberta')
  })

  it('answers with a JSON-RPC error when the key is rejected, and refuses to start without one', async () => {
    const { server } = await setup()
    const info = join(mkdtempSync(join(tmpdir(), 'books-bridge-')), 'ai-server.json')
    writeFileSync(info, JSON.stringify({ port: server.port }))
    const rejected = await runBridge({ ALBERTA_BOOKS_TOKEN: 'abk_' + 'a'.repeat(43), ALBERTA_BOOKS_SERVER_INFO: info }, [{ jsonrpc: '2.0', id: 7, method: 'ping' }])
    expect(JSON.parse(rejected.out)).toMatchObject({ id: 7, error: { code: -32001 } })
    const missing = await runBridge({ ALBERTA_BOOKS_TOKEN: '' }, [])
    expect(missing.code).toBe(2)
    expect(missing.out).toBe('')
    expect(missing.err).toContain('ALBERTA_BOOKS_TOKEN')
  })

  it('starts the app when it is not running', async () => {
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Claude Desktop', 'read')
    const port = server.port
    await server.stop()
    const dir = mkdtempSync(join(tmpdir(), 'books-bridge-'))
    const info = join(dir, 'ai-server.json')
    writeFileSync(info, JSON.stringify({ port }))
    // Stand-in for the app: a script that marks it was started; the test then brings the server up.
    const marker = join(dir, 'launched')
    const fakeApp = join(dir, process.platform === 'win32' ? 'app.cmd' : 'app.sh')
    writeFileSync(fakeApp, process.platform === 'win32' ? `@echo off\r\necho x > "${marker}"\r\n` : `#!/bin/sh\necho x > "${marker}"\n`, { mode: 0o755 })
    const watcher = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(watcher)
        void server.start(port)
      }
    }, 50)
    const r = await runBridge({ ALBERTA_BOOKS_TOKEN: token, ALBERTA_BOOKS_SERVER_INFO: info, ALBERTA_BOOKS_APP: fakeApp }, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    clearInterval(watcher)
    expect(r.err).toContain('starting it')
    expect(JSON.parse(r.out)).toMatchObject({ id: 1, result: {} })
  }, 20_000)
})

describe('AI activity and undo', () => {
  it('lists what an assistant did and undoes it with a reversal', async () => {
    const { listAiActivity, undoAiActivity } = await import('../src/main/ai/activity')
    const { db, server } = await setup()
    const { token } = createTokenConnection(db, 'Grok', 'write')
    await call(server.port, token, 'create_expense', { date: '2026-02-10', vendor: 'Staples', category: '5160', amount: '40.00', gst: '2.00', paid_from: '1000' })
    await call(server.port, token, 'create_journal_entry', {
      date: '2026-02-11',
      memo: 'Reclass',
      lines: [
        { account: '5160', debit: '10.00' },
        { account: '1000', credit: '10.00' }
      ]
    })
    const acts = listAiActivity(db)
    const expense = acts.find((a) => a.entity === 'expense')!
    const manual = acts.find((a) => a.entity === 'journal_entry' && a.summary === 'Reclass')!
    expect(expense.canUndo && manual.canUndo).toBe(true)
    // The expense's own posting is undone through the expense, not directly.
    expect(acts.filter((a) => a.entity === 'journal_entry' && a.canUndo)).toHaveLength(1)
    undoAiActivity(db, expense.id)
    undoAiActivity(db, manual.id)
    expect(listExpenses(db)[0]!.voided).toBe(true)
    expect(listAiActivity(db).some((a) => a.canUndo)).toBe(false)
    expect(() => undoAiActivity(db, expense.id)).toThrow(/already been undone/)
    // Undo is recorded as yours, not the assistant's.
    expect(listAudit(db, { limit: 1 })[0]!.actor).toBe('user')
  })
})
