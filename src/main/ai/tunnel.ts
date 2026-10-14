/**
 * Makes the local AI server reachable from the internet, which Grok (it runs
 * in xAI's cloud) needs. Uses Cloudflare's free `cloudflared`:
 *
 *  - quick:  a temporary https://<random>.trycloudflare.com address, no
 *            account needed. The address changes every time it starts.
 *  - named:  your own Cloudflare tunnel (permanent address on your domain),
 *            started with the tunnel token from the Cloudflare dashboard.
 *
 * The tunnel only forwards to 127.0.0.1:<port>; every request still needs an
 * approved connection. Turning the tunnel off closes internet access.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type TunnelState = { status: 'off' } | { status: 'starting' } | { status: 'on'; url: string } | { status: 'error'; error: string }

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export function findCloudflared(): string | null {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    dirs.push(join(pf86, 'cloudflared'), join(pf, 'cloudflared'))
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'))
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  }
  for (const d of dirs) {
    const p = join(d, exe)
    if (existsSync(p)) return p
  }
  return null
}

/** Installs cloudflared with winget (Windows) or Homebrew (macOS). Resolves when done. */
export function installCloudflared(): Promise<void> {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['winget', ['install', '--id', 'Cloudflare.cloudflared', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements']]
      : process.platform === 'darwin'
        ? ['brew', ['install', 'cloudflared']]
        : [null, []]
  if (!cmd) return Promise.reject(new Error('Install cloudflared with your package manager.'))
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => reject(new Error(`${cmd} is not available. Download cloudflared from Cloudflare's website.`)))
    child.on('exit', (code) => (code === 0 || findCloudflared() ? resolve() : reject(new Error(`Installing cloudflared failed (exit code ${code}).`))))
  })
}

export class Tunnel {
  private child: ChildProcess | null = null
  state: TunnelState = { status: 'off' }

  constructor(private onChange: (s: TunnelState) => void) {}

  private set(s: TunnelState): void {
    this.state = s
    this.onChange(s)
  }

  get url(): string | null {
    return this.state.status === 'on' ? this.state.url : null
  }

  /** `named`: the tunnel token from Cloudflare and the public hostname you set up for it. */
  start(localPort: number, named?: { token: string; hostname: string }): Promise<string> {
    this.stop()
    const bin = findCloudflared()
    if (!bin) {
      const error = 'cloudflared is not installed.'
      this.set({ status: 'error', error })
      return Promise.reject(new Error(error))
    }
    this.set({ status: 'starting' })
    const args = named
      ? // Remotely managed tunnel: its public hostname points to http://127.0.0.1:<port> in the Cloudflare dashboard.
        ['tunnel', '--no-autoupdate', 'run']
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`]
    // The named-tunnel token goes through the environment, not the command line (other programs can read command lines).
    const env = { ...process.env, ...(named ? { TUNNEL_TOKEN: named.token } : {}) }
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err: Error | null, url?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          if (this.child === child) {
            this.set({ status: 'error', error: err.message })
            this.stop(false)
          }
          reject(err)
        } else {
          this.set({ status: 'on', url: url! })
          resolve(url!)
        }
      }
      const timer = setTimeout(() => done(new Error('The tunnel did not start within 45 seconds. Check your internet connection.')), 45_000)
      let log = ''
      const onData = (chunk: Buffer) => {
        log = (log + chunk.toString('utf8')).slice(-8000)
        if (named) {
          if (/Registered tunnel connection/i.test(log)) done(null, `https://${named.hostname}`)
          if (/Unauthorized|invalid token|failed to unmarshal/i.test(log)) done(new Error('Cloudflare rejected the tunnel token.'))
        } else {
          const m = QUICK_URL.exec(log)
          // The URL is printed before the connection is ready; wait for the first registered connection too.
          if (m && /Registered tunnel connection/i.test(log)) done(null, m[0])
        }
      }
      child.stdout!.on('data', onData)
      child.stderr!.on('data', onData)
      child.on('error', (err) => done(err))
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null
          if (settled) this.set({ status: 'error', error: `The tunnel stopped (exit code ${code}).` })
        }
        done(new Error(`cloudflared stopped (exit code ${code}).`))
      })
    })
  }

  stop(notify = true): void {
    const c = this.child
    this.child = null
    if (c && c.exitCode === null) c.kill()
    if (notify) this.set({ status: 'off' })
  }
}
