/**
 * Who may use the books through an AI assistant, and how they prove it.
 *
 *  - Personal tokens (Claude Code, Claude Desktop): created in Settings, shown
 *    once, stored only as a SHA-256 hash.
 *  - OAuth (Grok on grok.com): the assistant registers itself, you approve it
 *    in the desktop app, it receives a one-hour access token plus a refresh
 *    token. Both are stored only as hashes and can be revoked at any time.
 *
 * Every connection is either read-only or read-and-write.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { audit } from '../services/audit'
import type { AiConnection, AiMode } from '../../shared/types'

export type { AiConnection, AiMode }



interface ConnectionRow {
  id: number
  name: string
  kind: 'token' | 'oauth'
  mode: 'read' | 'write'
  full_control: number
  confirm_final: number
  client_id: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

const toConnection = (r: ConnectionRow): AiConnection => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  mode: r.full_control ? 'full' : r.mode,
  confirmFinal: r.confirm_final === 1,
  clientId: r.client_id,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at
})

/** Stored as mode read|write plus the full_control flag. */
const dbMode = (mode: AiMode) => (mode === 'read' ? 'read' : 'write')
const fullFlag = (mode: AiMode) => (mode === 'full' ? 1 : 0)
const SCOPES: Record<AiMode, string> = { read: 'books.read', write: 'books.read books.write', full: 'books.read books.write books.full' }

export const ACCESS_TOKEN_SECONDS = 3600
const REFRESH_TOKEN_DAYS = 60

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const cleanName = (name: string) => name.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 60) || 'AI assistant'

export function listConnections(db: Db, includeRevoked = false): AiConnection[] {
  return db
    .all<ConnectionRow>(`SELECT * FROM ai_connections WHERE (? OR revoked_at IS NULL) ORDER BY id DESC`, includeRevoked ? 1 : 0)
    .map(toConnection)
}

export function getConnection(db: Db, id: number): AiConnection {
  const r = db.get<ConnectionRow>('SELECT * FROM ai_connections WHERE id = ?', id)
  if (!r) throw new UserError('Connection not found.')
  return toConnection(r)
}

/** Creates a personal token. The token itself is returned only here. */
export function createTokenConnection(db: Db, name: string, mode: AiMode): { connection: AiConnection; token: string } {
  const token = newSecret('abk')
  const { lastInsertRowid } = db.run(
    `INSERT INTO ai_connections (name, kind, mode, full_control, token_hash) VALUES (?, 'token', ?, ?, ?)`,
    cleanName(name),
    dbMode(mode),
    fullFlag(mode),
    sha256(token)
  )
  audit(db, 'create', 'ai_connection', lastInsertRowid, `${cleanName(name)} (${mode})`)
  return { connection: getConnection(db, lastInsertRowid), token }
}

export function setConnectionMode(db: Db, id: number, mode: AiMode): AiConnection {
  const c = getConnection(db, id)
  if (c.revokedAt) throw new UserError('That connection was removed.')
  db.run('UPDATE ai_connections SET mode = ?, full_control = ? WHERE id = ?', dbMode(mode), fullFlag(mode), id)
  audit(db, 'update', 'ai_connection', id, `${c.name}: ${mode}`)
  return getConnection(db, id)
}

/** Full control: whether the app asks you before each final action. */
export function setConnectionConfirm(db: Db, id: number, confirm: boolean): AiConnection {
  const c = getConnection(db, id)
  if (c.revokedAt) throw new UserError('That connection was removed.')
  db.run('UPDATE ai_connections SET confirm_final = ? WHERE id = ?', confirm ? 1 : 0, id)
  audit(db, 'update', 'ai_connection', id, `${c.name}: ${confirm ? 'asks before final actions' : 'final actions without asking'}`)
  return getConnection(db, id)
}

export function revokeConnection(db: Db, id: number): void {
  const c = getConnection(db, id)
  db.tx(() => {
    db.run(`UPDATE ai_connections SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), token_hash = NULL WHERE id = ? AND revoked_at IS NULL`, id)
    db.run('DELETE FROM oauth_tokens WHERE connection_id = ?', id)
    audit(db, 'revoke', 'ai_connection', id, c.name)
  })
}

/** Finds the live connection a bearer token belongs to (personal token or OAuth access token). */
export function authenticate(db: Db, bearer: string): AiConnection | null {
  if (!/^ab[ka]_[\w-]{43}$/.test(bearer)) return null
  const hash = sha256(bearer)
  let row: ConnectionRow | undefined
  if (bearer.startsWith('abk_')) {
    row = db.get<ConnectionRow>(`SELECT * FROM ai_connections WHERE token_hash = ? AND kind = 'token' AND revoked_at IS NULL`, hash)
  } else {
    row = db.get<ConnectionRow>(
      `SELECT c.* FROM oauth_tokens t JOIN ai_connections c ON c.id = t.connection_id
       WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND c.revoked_at IS NULL`,
      hash
    )
  }
  if (!row) return null
  // At most one write per minute per connection for "last used".
  db.run(
    `UPDATE ai_connections SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))`,
    row.id
  )
  return toConnection(row)
}

// ---------------------------------------------------------------- OAuth clients

export interface OAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
}

/** Built-in public client for assistants that ask for a client ID up front (PKCE, no secret). */
export const BUILTIN_CLIENTS: Record<string, string> = { grok: 'Grok', claude: 'Claude' }

/** Redirect URIs must be https, or http on this computer (desktop apps). */
export function validRedirectUri(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
}

export function registerClient(db: Db, clientName: string, redirectUris: string[]): OAuthClient {
  if (!redirectUris.length || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
    throw new UserError('redirect_uris must be https (or http://127.0.0.1) addresses.')
  }
  if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients')!.n >= 200) throw new UserError('Too many registered clients.')
  const clientId = `abc_${randomBytes(16).toString('base64url')}`
  db.run('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)', clientId, cleanName(clientName), JSON.stringify(redirectUris))
  return { clientId, clientName: cleanName(clientName), redirectUris }
}

/** Registered client, or a built-in one (which accepts any valid redirect URI; you approve each one). */
export function getClient(db: Db, clientId: string): OAuthClient | null {
  if (Object.hasOwn(BUILTIN_CLIENTS, clientId)) return { clientId, clientName: BUILTIN_CLIENTS[clientId]!, redirectUris: [] }
  const r = db.get<{ client_id: string; client_name: string; redirect_uris: string }>('SELECT * FROM oauth_clients WHERE client_id = ?', clientId)
  return r ? { clientId: r.client_id, clientName: r.client_name, redirectUris: JSON.parse(r.redirect_uris) as string[] } : null
}

export function redirectAllowed(client: OAuthClient, uri: string): boolean {
  if (!validRedirectUri(uri)) return false
  return client.redirectUris.length === 0 ? Object.hasOwn(BUILTIN_CLIENTS, client.clientId) : client.redirectUris.includes(uri)
}

// ---------------------------------------------------------------- OAuth tokens

export interface TokenSet {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

function issueTokens(db: Db, connectionId: number, mode: AiMode): TokenSet {
  const access = newSecret('aba')
  const refresh = newSecret('abr')
  db.run(
    `INSERT INTO oauth_tokens (token_hash, kind, connection_id, expires_at) VALUES (?, 'access', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`,
    sha256(access),
    connectionId,
    `+${ACCESS_TOKEN_SECONDS} seconds`
  )
  db.run(
    `INSERT INTO oauth_tokens (token_hash, kind, connection_id, expires_at) VALUES (?, 'refresh', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))`,
    sha256(refresh),
    connectionId,
    `+${REFRESH_TOKEN_DAYS} days`
  )
  db.run(`DELETE FROM oauth_tokens WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: SCOPES[mode] }
}

/** After you approve an assistant: one connection per approval. */
export function createOAuthConnection(db: Db, client: OAuthClient, mode: AiMode): TokenSet {
  return db.tx(() => {
    const { lastInsertRowid } = db.run(
      `INSERT INTO ai_connections (name, kind, mode, full_control, client_id) VALUES (?, 'oauth', ?, ?, ?)`,
      client.clientName,
      dbMode(mode),
      fullFlag(mode),
      client.clientId
    )
    audit(db, 'approve', 'ai_connection', lastInsertRowid, `${client.clientName} (${mode})`)
    return issueTokens(db, lastInsertRowid, mode)
  })
}

/** Refresh tokens rotate: each one works once. */
export function refreshTokens(db: Db, refreshToken: string): TokenSet | null {
  if (!/^abr_[\w-]{43}$/.test(refreshToken)) return null
  return db.tx(() => {
    const row = db.get<{ connection_id: number; mode: 'read' | 'write'; full_control: number }>(
      `SELECT t.connection_id, c.mode, c.full_control FROM oauth_tokens t JOIN ai_connections c ON c.id = t.connection_id
       WHERE t.token_hash = ? AND t.kind = 'refresh' AND t.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND c.revoked_at IS NULL`,
      sha256(refreshToken)
    )
    if (!row) return null
    db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', sha256(refreshToken))
    return issueTokens(db, row.connection_id, row.full_control ? 'full' : row.mode)
  })
}
