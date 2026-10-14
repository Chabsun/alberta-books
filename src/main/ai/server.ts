/**
 * Local HTTP server that lets AI assistants use the books (MCP over
 * "Streamable HTTP", JSON responses), plus the OAuth 2.1 endpoints Grok uses
 * to connect: metadata discovery, dynamic client registration, authorization
 * with PKCE (approved by you in the desktop app) and tokens.
 *
 * Listens on 127.0.0.1 only. Internet access exists only while you turn on a
 * tunnel (see tunnel.ts), and every request still needs a token.
 *
 * Protections: Host header allow-list (blocks DNS rebinding), Origin check,
 * body size limits, one approval prompt at a time, rate limits on
 * registration, approval requests and failed sign-ins.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { logError } from '../log'
import {
  authenticate,
  createOAuthConnection,
  getClient,
  redirectAllowed,
  refreshTokens,
  registerClient,
  type AiMode,
  type OAuthClient
} from './connections'
import { handleMessage, SERVER_INFO } from './mcp'

export interface ApprovalRequest {
  clientName: string
  redirectHost: string
  viaInternet: boolean
}

export interface AiServerOptions {
  /** 0 picks a free port (tests). */
  port: number
  getDb: () => Db
  receiptsDir: () => string
  /** Public https address while a tunnel is on, e.g. https://abc.trycloudflare.com */
  publicUrl: () => string | null
  /** Asks you in the desktop app. Resolves to the access you granted, or null for "Deny". */
  approve: (req: ApprovalRequest) => Promise<AiMode | null>
  /** Called after every successful write by an assistant (the UI refreshes). */
  onActivity?: () => void
}

const MCP_MAX_BYTES = 30 * 1024 * 1024
const SMALL_MAX_BYTES = 64 * 1024
const APPROVAL_TIMEOUT_MS = 5 * 60_000
const CODE_TTL_MS = 2 * 60_000

/** Browser-based assistants that may call the server directly. */
const ALLOWED_ORIGINS = [/^https:\/\/(www\.)?grok\.com$/, /^https:\/\/([\w-]+\.)*x\.ai$/, /^https:\/\/claude\.ai$/]

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
  }
}

/** Fixed-window counter: at most `max` events per `windowMs`. */
class Limiter {
  private hits: number[] = []
  constructor(
    private max: number,
    private windowMs: number
  ) {}
  take(): boolean {
    const now = Date.now()
    this.hits = this.hits.filter((t) => now - t < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(now)
    return true
  }
}

interface PendingAuth {
  client: OAuthClient
  redirectUri: string
  state: string | null
  challenge: string
  status: 'pending' | 'done'
  location?: string
  expires: number
}

interface AuthCode {
  client: OAuthClient
  redirectUri: string
  challenge: string
  mode: AiMode
  expires: number
}

const b64url = (buf: Buffer) => buf.toString('base64url')
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest())

export class AiServer {
  private server: Server | null = null
  private boundPort = 0
  private pending = new Map<string, PendingAuth>()
  private codes = new Map<string, AuthCode>()
  private approving = false
  private registerLimit = new Limiter(20, 60 * 60_000)
  private authorizeLimit = new Limiter(10, 10 * 60_000)
  private failedAuthLimit = new Limiter(30, 60_000)

  constructor(private opts: AiServerOptions) {}

  get port(): number {
    return this.boundPort
  }

  get localUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`
  }

  get running(): boolean {
    return this.server !== null
  }

  start(port = this.opts.port): Promise<number> {
    if (this.server) return Promise.resolve(this.boundPort)
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.route(req, res).catch((err: unknown) => this.sendError(res, err))
      })
      server.headersTimeout = 20_000
      server.requestTimeout = 120_000
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (err) => logError('ai-server', err))
        this.server = server
        this.boundPort = (server.address() as { port: number }).port
        resolve(this.boundPort)
      })
    })
  }

  stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (!s) return Promise.resolve()
    s.closeAllConnections()
    return new Promise((resolve) => s.close(() => resolve()))
  }

  // ---------------------------------------------------------------- routing

  private publicHost(): string | null {
    const url = this.opts.publicUrl()
    if (!url) return null
    try {
      return new URL(url).host.toLowerCase()
    } catch {
      return null
    }
  }

  /** The address the client used to reach us: local, or the public tunnel. */
  private baseUrl(req: IncomingMessage): string {
    const host = (req.headers.host ?? '').toLowerCase()
    const pub = this.publicHost()
    const forwarded = req.headers['x-forwarded-for'] !== undefined || req.headers['cf-connecting-ip'] !== undefined
    if (pub && (host === pub || forwarded)) return `https://${pub}`
    return this.localUrl
  }

  private checkHost(req: IncomingMessage): void {
    const host = (req.headers.host ?? '').toLowerCase()
    const allowed = [`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`, `[::1]:${this.boundPort}`]
    const pub = this.publicHost()
    if (pub) allowed.push(pub)
    if (!allowed.includes(host)) throw new HttpError(421, 'Unknown host')
    const origin = req.headers.origin
    if (origin && origin !== 'null') {
      const ownOrigins = allowed.map((h) => (h === pub ? `https://${h}` : `http://${h}`))
      if (!ownOrigins.includes(origin.toLowerCase()) && !ALLOWED_ORIGINS.some((re) => re.test(origin))) {
        throw new HttpError(403, 'Origin not allowed')
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.checkHost(req)
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    this.cors(req, res)
    if (req.method === 'OPTIONS') return this.send(res, 204, '')

    if (path === '/mcp') {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST', { Allow: 'POST' })
      return this.mcp(req, res)
    }
    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      const base = this.baseUrl(req)
      return this.json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['books.read', 'books.write'],
        bearer_methods_supported: ['header'],
        resource_name: 'Alberta Books'
      })
    }
    if (req.method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) {
      const base = this.baseUrl(req)
      return this.json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['books.read', 'books.write']
      })
    }
    if (req.method === 'POST' && path === '/register') return this.register(req, res)
    if (req.method === 'GET' && path === '/authorize') return this.authorize(req, res, url)
    if (req.method === 'GET' && path === '/authorize/status') return this.authorizeStatus(res, url)
    if (req.method === 'POST' && path === '/token') return this.token(req, res)
    if (req.method === 'GET' && path === '/') return this.send(res, 200, `${SERVER_INFO.title} MCP server. Connect your assistant to ${this.baseUrl(req)}/mcp\n`, 'text/plain; charset=utf-8')
    throw new HttpError(404, 'Not found')
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    if (!origin) return
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id')
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id')
  }

  // ---------------------------------------------------------------- MCP

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? ''
    const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1]
    const connection = bearer ? authenticate(this.opts.getDb(), bearer) : null
    if (!connection) {
      if (bearer && !this.failedAuthLimit.take()) throw new HttpError(429, 'Too many failed sign-ins. Wait a minute.')
      throw new HttpError(401, 'Sign in required', {
        'WWW-Authenticate': `Bearer realm="alberta-books", resource_metadata="${this.baseUrl(req)}/.well-known/oauth-protected-resource"`
      })
    }
    const body = await this.readJson(req, MCP_MAX_BYTES)
    const ctx = { db: this.opts.getDb(), receiptsDir: this.opts.receiptsDir(), connection }
    const messages = Array.isArray(body) ? body : [body]
    if (messages.length === 0 || messages.length > 50) throw new HttpError(400, 'Send 1 to 50 messages')
    const replies = messages.map((m) => handleMessage(m, ctx)).filter((r) => r !== null)
    if (messages.some((m) => (m as { method?: string })?.method === 'tools/call')) this.opts.onActivity?.()
    if (replies.length === 0) return this.send(res, 202, '')
    return this.json(res, 200, Array.isArray(body) ? replies : replies[0])
  }

  // ---------------------------------------------------------------- OAuth

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.registerLimit.take()) throw new HttpError(429, 'Too many registrations')
    const body = (await this.readJson(req, SMALL_MAX_BYTES)) as Record<string, unknown>
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length < 2000) : []
    const method = body?.token_endpoint_auth_method
    if (method !== undefined && method !== 'none') {
      return this.json(res, 400, { error: 'invalid_client_metadata', error_description: 'Only public clients (token_endpoint_auth_method "none", PKCE) are supported.' })
    }
    try {
      const c = registerClient(this.opts.getDb(), typeof body?.client_name === 'string' ? body.client_name : 'AI assistant', uris)
      return this.json(res, 201, {
        client_id: c.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: c.clientName,
        redirect_uris: c.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    } catch (err) {
      if (err instanceof UserError) return this.json(res, 400, { error: 'invalid_redirect_uri', error_description: err.message })
      throw err
    }
  }

  private async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams
    const client = getClient(this.opts.getDb(), q.get('client_id') ?? '')
    const redirectUri = q.get('redirect_uri') ?? client?.redirectUris[0] ?? ''
    // Never redirect to an address that isn't registered.
    if (!client || !redirectAllowed(client, redirectUri)) {
      return this.page(res, 400, 'Cannot connect', 'This assistant is not registered, or its return address is not allowed.')
    }
    const back = (params: Record<string, string>) => {
      const to = new URL(redirectUri)
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v)
      if (q.get('state') !== null) to.searchParams.set('state', q.get('state')!)
      to.searchParams.set('iss', this.baseUrl(req))
      return to.toString()
    }
    if (q.get('response_type') !== 'code') return this.redirect(res, back({ error: 'unsupported_response_type' }))
    const challenge = q.get('code_challenge') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || !/^[\w-]{43,128}$/.test(challenge)) {
      return this.redirect(res, back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }))
    }
    if (this.approving || !this.authorizeLimit.take()) {
      return this.redirect(res, back({ error: 'temporarily_unavailable', error_description: 'Another approval is waiting in Alberta Books' }))
    }

    const id = b64url(randomBytes(24))
    const pending: PendingAuth = { client, redirectUri, state: q.get('state'), challenge, status: 'pending', expires: Date.now() + APPROVAL_TIMEOUT_MS }
    this.pending.set(id, pending)
    this.approving = true
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), APPROVAL_TIMEOUT_MS).unref())
    void Promise.race([
      this.opts.approve({ clientName: client.clientName, redirectHost: new URL(redirectUri).host, viaInternet: this.baseUrl(req) !== this.localUrl }),
      timeout
    ])
      .catch((err: unknown) => {
        logError('ai-approve', err)
        return null
      })
      .then((mode) => {
        this.approving = false
        if (mode) {
          const code = b64url(randomBytes(32))
          this.codes.set(code, { client, redirectUri, challenge, mode, expires: Date.now() + CODE_TTL_MS })
          pending.location = back({ code })
        } else {
          pending.location = back({ error: 'access_denied', error_description: 'Not approved in Alberta Books' })
        }
        pending.status = 'done'
      })

    // A waiting page that checks every second (a held-open request would time out behind a tunnel).
    const nonce = b64url(randomBytes(16))
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`)
    return this.page(
      res,
      200,
      'Approve in Alberta Books',
      `<b>${escapeHtml(client.clientName)}</b> is asking to use your books. Switch to Alberta Books on your computer and choose what to allow.`,
      `<script nonce="${nonce}">
const id = ${JSON.stringify(id)};
async function check() {
  try {
    const r = await fetch('/authorize/status?id=' + encodeURIComponent(id), { cache: 'no-store' });
    const s = await r.json();
    if (s.location) { location.replace(s.location); return; }
    if (s.status === 'expired') { document.querySelector('p').textContent = 'This request expired. Start again from your assistant.'; return; }
  } catch {}
  setTimeout(check, 1000);
}
check();
</script>`
    )
  }

  private authorizeStatus(res: ServerResponse, url: URL): void {
    const id = url.searchParams.get('id') ?? ''
    const p = this.pending.get(id)
    if (!p || p.expires < Date.now() - 60_000) {
      this.pending.delete(id)
      return this.json(res, 200, { status: 'expired' })
    }
    if (p.status === 'done') {
      this.pending.delete(id)
      return this.json(res, 200, { status: 'done', location: p.location })
    }
    return this.json(res, 200, { status: 'pending' })
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readForm(req)
    const bad = (error: string, description: string) => this.json(res, 400, { error, error_description: description })
    res.setHeader('Cache-Control', 'no-store')
    const db = this.opts.getDb()
    if (body.grant_type === 'authorization_code') {
      const code = this.codes.get(body.code ?? '')
      if (code) this.codes.delete(body.code!) // single use, even when the rest is wrong
      if (!code || code.expires < Date.now()) return bad('invalid_grant', 'The code is invalid or expired.')
      if (body.client_id && body.client_id !== code.client.clientId) return bad('invalid_grant', 'Wrong client.')
      if (body.redirect_uri && body.redirect_uri !== code.redirectUri) return bad('invalid_grant', 'Wrong redirect_uri.')
      if (!body.code_verifier || s256(body.code_verifier) !== code.challenge) return bad('invalid_grant', 'PKCE verification failed.')
      return this.json(res, 200, createOAuthConnection(db, code.client, code.mode))
    }
    if (body.grant_type === 'refresh_token') {
      const tokens = refreshTokens(db, body.refresh_token ?? '')
      if (!tokens) {
        this.failedAuthLimit.take()
        return bad('invalid_grant', 'The refresh token is invalid, expired or revoked.')
      }
      return this.json(res, 200, tokens)
    }
    return bad('unsupported_grant_type', 'Use authorization_code or refresh_token.')
  }

  // ---------------------------------------------------------------- plumbing

  private readBody(req: IncomingMessage, max: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0)
      if (declared > max) return reject(new HttpError(413, 'Request too large'))
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > max) {
          reject(new HttpError(413, 'Request too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private async readJson(req: IncomingMessage, max: number): Promise<unknown> {
    const raw = await this.readBody(req, max)
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'Body must be JSON')
    }
  }

  private async readForm(req: IncomingMessage): Promise<Record<string, string | undefined>> {
    const raw = (await this.readBody(req, SMALL_MAX_BYTES)).toString('utf8')
    if ((req.headers['content-type'] ?? '').includes('application/json')) {
      try {
        const o = JSON.parse(raw) as Record<string, unknown>
        return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      } catch {
        throw new HttpError(400, 'Body must be JSON')
      }
    }
    return Object.fromEntries(new URLSearchParams(raw))
  }

  private send(res: ServerResponse, status: number, body: string, type?: string): void {
    if (type) res.setHeader('Content-Type', type)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.writeHead(status)
    res.end(body)
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    this.send(res, status, JSON.stringify(body), 'application/json')
  }

  private redirect(res: ServerResponse, location: string): void {
    res.setHeader('Location', location)
    this.send(res, 302, '')
  }

  private page(res: ServerResponse, status: number, title: string, html: string, extra = ''): void {
    if (!res.hasHeader('Content-Security-Policy')) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    res.setHeader('X-Frame-Options', 'DENY')
    this.send(
      res,
      status,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f8;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 32px;max-width:420px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:18px;margin:0 0 8px}p{margin:0;line-height:1.5;color:#3f3f46}@media(prefers-color-scheme:dark){body{background:#111113;color:#f4f4f5}main{background:#1c1c1f;border-color:#2e2e33}p{color:#d4d4d8}}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${html}</p></main>${extra}</body></html>`,
      'text/html; charset=utf-8'
    )
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) return void res.end()
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v)
      return this.json(res, err.status, { error: err.message })
    }
    logError('ai-server', err)
    this.json(res, 500, { error: 'Internal error' })
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
