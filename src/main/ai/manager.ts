/**
 * Runs the AI assistant features inside the desktop app: starts and stops the
 * local server, the internet tunnel for Grok, asks you to approve new
 * assistants, and sets up Claude Desktop.
 */
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AiStatus } from '../../shared/types'
import type { AppContext } from '../context'
import { UserError } from '../errors'
import { logError } from '../log'
import { createTokenConnection, listConnections, type AiMode } from './connections'
import { AiServer, type ApprovalRequest } from './server'
import { findCloudflared, installCloudflared, Tunnel } from './tunnel'

export const DEFAULT_PORT = 47815
const PORT_TRIES = 10
const KEY = {
  enabled: 'ai_enabled',
  tunnelMode: 'ai_tunnel_mode',
  tunnelHostname: 'ai_tunnel_hostname',
  tunnelToken: 'ai_tunnel_token'
}

/** Written next to the books so `--mcp-stdio` can find the running server. */
export const serverInfoPath = () => join(app.getPath('userData'), 'ai-server.json')

export function readServerUrl(): string {
  try {
    const { port } = JSON.parse(readFileSync(serverInfoPath(), 'utf8')) as { port: number }
    if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
  } catch {
    // not started yet
  }
  return `http://127.0.0.1:${DEFAULT_PORT}`
}

/** Claude Desktop's config file (regular install, or the Microsoft Store version's private folder). */
export function claudeDesktopConfigPath(): string | null {
  if (process.platform === 'darwin') return join(app.getPath('home'), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (process.platform !== 'win32') return null
  const regular = join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json')
  if (existsSync(dirname(regular))) return regular
  const packages = join(process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local'), 'Packages')
  try {
    const store = readdirSync(packages).find((d) => /^(AnthropicPBC\.)?Claude_/i.test(d))
    if (store) return join(packages, store, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
  } catch {
    // no Store apps folder
  }
  return regular
}

export class AiManager {
  private server: AiServer
  private tunnel: Tunnel
  private error: string | null = null

  constructor(
    private ctx: () => AppContext,
    private window: () => BrowserWindow | null
  ) {
    this.server = new AiServer({
      port: DEFAULT_PORT,
      getDb: () => this.ctx().db,
      receiptsDir: () => this.ctx().receiptsDir,
      publicUrl: () => this.tunnel.url,
      approve: (r) => this.approve(r),
      onActivity: () => this.window()?.webContents.send('books:changed')
    })
    this.tunnel = new Tunnel(() => this.window()?.webContents.send('books:changed'))
  }

  private get(key: string): string | null {
    return this.ctx().db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null
  }

  private put(key: string, value: string | null): void {
    if (value === null) this.ctx().db.run('DELETE FROM settings WHERE key = ?', key)
    else this.ctx().db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  get enabled(): boolean {
    return this.get(KEY.enabled) === '1'
  }

  /** Starts the server if AI assistants are turned on. Called at startup and after a restore. */
  async startIfEnabled(): Promise<void> {
    if (this.enabled) await this.startServer()
  }

  private async startServer(): Promise<void> {
    if (this.server.running) return
    this.error = null
    for (let i = 0; i < PORT_TRIES; i++) {
      try {
        const port = await this.server.start(DEFAULT_PORT + i)
        writeFileSync(serverInfoPath(), JSON.stringify({ port, pid: process.pid }))
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          this.error = err instanceof Error ? err.message : String(err)
          logError('ai-start', err)
          return
        }
      }
    }
    this.error = `Ports ${DEFAULT_PORT} to ${DEFAULT_PORT + PORT_TRIES - 1} are all in use.`
  }

  async setEnabled(on: boolean): Promise<AiStatus> {
    this.put(KEY.enabled, on ? '1' : null)
    if (on) await this.startServer()
    else await this.shutdown()
    return this.status()
  }

  async shutdown(): Promise<void> {
    this.tunnel.stop()
    await this.server.stop()
  }

  status(): AiStatus {
    const t = this.tunnel.state
    const configPath = claudeDesktopConfigPath()
    let connected = false
    try {
      if (configPath && existsSync(configPath)) connected = !!(JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.['alberta-books']
    } catch {
      // unreadable config: shown as not connected
    }
    return {
      enabled: this.enabled,
      running: this.server.running,
      port: this.server.port || DEFAULT_PORT,
      mcpUrl: `http://127.0.0.1:${this.server.port || DEFAULT_PORT}/mcp`,
      error: this.error,
      tunnel: {
        status: t.status,
        mcpUrl: t.status === 'on' ? `${t.url}/mcp` : null,
        error: t.status === 'error' ? t.error : null,
        mode: this.get(KEY.tunnelMode) === 'named' ? 'named' : 'quick',
        hostname: this.get(KEY.tunnelHostname),
        hasToken: this.get(KEY.tunnelToken) !== null
      },
      cloudflaredInstalled: findCloudflared() !== null,
      connections: listConnections(this.ctx().db),
      claudeDesktop: { configPath, connected }
    }
  }

  // ---------------------------------------------------------------- tunnel

  async startTunnel(input: { mode: 'quick' } | { mode: 'named'; hostname: string; token?: string }): Promise<AiStatus> {
    if (!this.server.running) throw new UserError('Turn on AI assistants first.')
    let named: { token: string; hostname: string } | undefined
    if (input.mode === 'named') {
      const hostname = input.hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname)) throw new UserError('Enter the public hostname, like books.example.com.')
      let token = input.token?.trim()
      if (token) {
        if (!safeStorage.isEncryptionAvailable()) throw new UserError('Windows could not protect the token on this computer.')
        this.put(KEY.tunnelToken, safeStorage.encryptString(token).toString('base64'))
      } else {
        const stored = this.get(KEY.tunnelToken)
        if (!stored) throw new UserError('Paste the tunnel token from the Cloudflare dashboard.')
        token = safeStorage.decryptString(Buffer.from(stored, 'base64'))
      }
      this.put(KEY.tunnelHostname, hostname)
      named = { token, hostname }
    }
    this.put(KEY.tunnelMode, input.mode)
    try {
      await this.tunnel.start(this.server.port, named)
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'The tunnel could not start.')
    }
    return this.status()
  }

  stopTunnel(): AiStatus {
    this.tunnel.stop()
    return this.status()
  }

  async installCloudflared(): Promise<AiStatus> {
    try {
      await installCloudflared()
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : 'cloudflared could not be installed.')
    }
    return this.status()
  }

  // ---------------------------------------------------------------- approvals and Claude

  private async approve(r: ApprovalRequest): Promise<AiMode | null> {
    const win = this.window()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.flashFrame(true)
    }
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Connect an AI assistant',
      message: `${r.clientName} wants to use your books`,
      detail: [
        `It will return to: ${r.redirectHost}`,
        r.viaInternet ? 'The request came through the internet tunnel.' : 'The request came from this computer.',
        '',
        'Only allow this if you just started connecting this assistant yourself.',
        '“Read only” lets it see your books. “Read and make changes” also lets it categorize transactions and record expenses (every change is logged and can be undone).',
        'You can remove access at any time in Settings → AI assistants.'
      ].join('\n'),
      buttons: ['Allow read and make changes', 'Allow read only', 'Deny'],
      defaultId: 2,
      cancelId: 2,
      noLink: true
    }
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    win?.flashFrame(false)
    return response === 0 ? 'write' : response === 1 ? 'read' : null
  }

  /** The command Claude Desktop runs: this app with --mcp-stdio. */
  private bridgeCommand(): { command: string; args: string[] } {
    return app.isPackaged ? { command: process.execPath, args: ['--mcp-stdio'] } : { command: process.execPath, args: [app.getAppPath(), '--mcp-stdio'] }
  }

  /** Creates a token for Claude Desktop and adds Alberta Books to its config (keeping a .bak copy). */
  connectClaudeDesktop(mode: AiMode): AiStatus {
    const path = claudeDesktopConfigPath()
    if (!path) throw new UserError('Claude Desktop is not available on this system.')
    let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        config = JSON.parse(readFileSync(path, 'utf8')) as typeof config
      } catch {
        throw new UserError(`Claude Desktop's settings file could not be read (${path}). Fix or remove it, then try again.`)
      }
      copyFileSync(path, `${path}.bak`)
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new UserError('Claude Desktop’s settings file is not in the expected format.')
    const { token } = createTokenConnection(this.ctx().db, 'Claude Desktop', mode)
    config.mcpServers = { ...(config.mcpServers ?? {}), 'alberta-books': { ...this.bridgeCommand(), env: { ALBERTA_BOOKS_TOKEN: token } } }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2))
    return this.status()
  }

  /** Creates a token and returns the one-line command for Claude Code. */
  connectClaudeCode(mode: AiMode): { status: AiStatus; command: string; token: string } {
    if (!this.server.running) throw new UserError('Turn on AI assistants first.')
    const { token } = createTokenConnection(this.ctx().db, 'Claude Code', mode)
    const url = `http://127.0.0.1:${this.server.port}/mcp`
    return {
      status: this.status(),
      token,
      command: `claude mcp add --transport http --scope user alberta-books ${url} --header "Authorization: Bearer ${token}"`
    }
  }

  createToken(name: string, mode: AiMode): { status: AiStatus; token: string } {
    const { token } = createTokenConnection(this.ctx().db, name, mode)
    return { status: this.status(), token }
  }
}
