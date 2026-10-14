import { useState } from 'react'
import { Bot, Copy, Globe, KeyRound, Monitor, Power, ShieldCheck, Terminal, Undo2 } from 'lucide-react'
import type { AiStatus } from '../../../shared/types'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, EmptyState, Field, Input, LoadingBlock, Modal, Notice, Page, PageHeader, Segmented, Select, td, th, tr } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { formatDateTime, relativeTime } from '../lib/format'

type Mode = 'read' | 'write'

function useCopy() {
  const fb = useFeedback()
  return (text: string, what = 'Copied') =>
    call('app.copy', { text })
      .then(() => fb.success(what))
      .catch((e: Error) => fb.error(e.message))
}

export default function Ai() {
  const fb = useFeedback()
  const { data: s, error } = useQuery('ai.status')
  const [busy, setBusy] = useState(false)

  async function toggle(on: boolean) {
    setBusy(true)
    try {
      await mutate('ai.setEnabled', { enabled: on })
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="AI assistants"
        subtitle="Let Claude and Grok read your books, categorize bank transactions and record expenses, with CRA rules applied and every change logged."
        actions={
          s ? (
            s.enabled ? (
              <Button icon={Power} onClick={() => toggle(false)} loading={busy}>
                Turn off
              </Button>
            ) : (
              <Button variant="primary" icon={Power} onClick={() => toggle(true)} loading={busy}>
                Turn on AI assistants
              </Button>
            )
          ) : null
        }
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!s ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-5">
          <StatusBar s={s} />
          {s.enabled ? (
            <>
              <div className="grid grid-cols-2 gap-5">
                <ClaudeDesktopCard s={s} />
                <ClaudeCodeCard s={s} />
              </div>
              <GrokCard s={s} />
            </>
          ) : (
            <Card>
              <EmptyState
                icon={Bot}
                title="AI assistants are off"
                body="When on, a private connection point runs on this computer only. Each assistant needs your approval, and you choose read-only or read-and-change."
              />
            </Card>
          )}
          <Connections s={s} />
          <Activity />
          <Safety />
        </div>
      )}
    </Page>
  )
}

function StatusBar({ s }: { s: AiStatus }) {
  const copy = useCopy()
  if (!s.enabled) return null
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3 text-sm shadow-xs">
      <span className={`size-2 rounded-full ${s.running ? 'bg-good' : 'bg-danger'}`} />
      {s.running ? (
        <>
          <span className="text-ink">Running on this computer at</span>
          <code className="rounded bg-subtle px-1.5 py-0.5 text-[13px]">{s.mcpUrl}</code>
          <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(s.mcpUrl, 'Address copied')}>
            Copy
          </Button>
        </>
      ) : (
        <span className="text-danger">{s.error ?? 'Not running.'}</span>
      )}
      {s.tunnel.status === 'on' ? (
        <Badge tone="warn" className="ml-auto">
          <Globe className="size-3" /> Reachable from the internet
        </Badge>
      ) : null}
    </div>
  )
}

function ModePick({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <Segmented<Mode>
      value={value}
      onChange={onChange}
      options={[
        { value: 'write', label: 'Read and make changes' },
        { value: 'read', label: 'Read only' }
      ]}
    />
  )
}

function ClaudeDesktopCard({ s }: { s: AiStatus }) {
  const fb = useFeedback()
  const [mode, setMode] = useState<Mode>('write')
  const [busy, setBusy] = useState(false)
  async function connect() {
    setBusy(true)
    try {
      await mutate('ai.connectClaudeDesktop', { mode })
      fb.success('Added to Claude Desktop. Quit and reopen Claude Desktop to use it.')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title={<span className="flex items-center gap-2"><Monitor className="size-4 text-accent" /> Claude Desktop</span>} actions={s.claudeDesktop.connected ? <Badge tone="good">Connected</Badge> : null}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Adds Alberta Books to Claude Desktop’s settings (a backup of them is kept). Claude talks to this app directly on your computer; nothing goes through the internet besides your conversation with Claude.</p>
        <ModePick value={mode} onChange={setMode} />
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={connect} loading={busy}>
            {s.claudeDesktop.connected ? 'Reconnect' : 'Connect Claude Desktop'}
          </Button>
          <span className="text-xs text-faint">Then restart Claude Desktop.</span>
        </div>
      </div>
    </Card>
  )
}

function ClaudeCodeCard({ s }: { s: AiStatus }) {
  const fb = useFeedback()
  const copy = useCopy()
  const [mode, setMode] = useState<Mode>('write')
  const [result, setResult] = useState<{ command: string } | null>(null)
  async function create() {
    try {
      const r = await mutate('ai.connectClaudeCode', { mode })
      setResult({ command: r.command })
    } catch (e) {
      fb.error((e as Error).message)
    }
  }
  return (
    <Card title={<span className="flex items-center gap-2"><Terminal className="size-4 text-accent" /> Claude Code</span>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Creates a personal key and the command to run once in a terminal. The key is shown only now.</p>
        <ModePick value={mode} onChange={setMode} />
        <Button variant="primary" icon={KeyRound} onClick={create} disabled={!s.running}>
          Create key and command
        </Button>
      </div>
      {result ? (
        <Modal
          open
          onClose={() => setResult(null)}
          title="Run this once in a terminal"
          description="It adds Alberta Books to Claude Code for your user. Keep it private: the key gives access to your books."
          footer={
            <>
              <Button onClick={() => setResult(null)}>Done</Button>
              <Button variant="primary" icon={Copy} onClick={() => copy(result.command, 'Command copied')}>
                Copy command
              </Button>
            </>
          }
        >
          <pre className="overflow-x-auto rounded-lg bg-subtle p-3 text-xs leading-relaxed whitespace-pre-wrap break-all text-ink">{result.command}</pre>
        </Modal>
      ) : null}
    </Card>
  )
}

function GrokCard({ s }: { s: AiStatus }) {
  const fb = useFeedback()
  const copy = useCopy()
  const [busy, setBusy] = useState<string | null>(null)
  const [kind, setKind] = useState<'quick' | 'named'>(s.tunnel.mode)
  const [hostname, setHostname] = useState(s.tunnel.hostname ?? '')
  const [token, setToken] = useState('')
  const t = s.tunnel

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name)
    try {
      await fn()
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card
      title={<span className="flex items-center gap-2"><Globe className="size-4 text-accent" /> Grok (grok.com and the Grok app)</span>}
      description="Grok runs in xAI’s cloud, so it needs a secure internet address that leads to this app. Turn it on only while you use Grok."
    >
      <ol className="space-y-5 text-sm">
        <li className="grid grid-cols-[28px_1fr] gap-3">
          <Step n={1} />
          <div className="space-y-3">
            <div className="font-medium text-ink">Open a secure internet address (Cloudflare Tunnel, free)</div>
            {!s.cloudflaredInstalled ? (
              <div className="flex items-center gap-3">
                <Button onClick={() => run('install', () => mutate('ai.installCloudflared'))} loading={busy === 'install'}>
                  Install Cloudflare Tunnel
                </Button>
                <span className="text-xs text-muted">Installs Cloudflare’s free “cloudflared” with Windows Package Manager.</span>
              </div>
            ) : t.status === 'on' ? (
              <div className="flex items-center gap-3">
                <Badge tone="good">On</Badge>
                <Button size="sm" onClick={() => run('stop', () => mutate('ai.stopTunnel'))} loading={busy === 'stop'}>
                  Turn off internet access
                </Button>
              </div>
            ) : (
              <>
                <Segmented
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: 'quick', label: 'Temporary address' },
                    { value: 'named', label: 'My own Cloudflare domain' }
                  ]}
                />
                {kind === 'quick' ? (
                  <p className="text-xs text-muted">No account needed. The address changes each time you turn it on, so you update it in Grok each time.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Public hostname" hint={`In Cloudflare Zero Trust → Tunnels, point it to http://127.0.0.1:${s.port}.`}>
                      {(id) => <Input id={id} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="books.example.com" />}
                    </Field>
                    <Field label="Tunnel token" hint={s.tunnel.hasToken ? 'Saved (encrypted). Paste again to replace.' : 'Stored encrypted with Windows.'}>
                      {(id) => <Input id={id} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.tunnel.hasToken ? '••••••••' : 'eyJ…'} />}
                    </Field>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    loading={busy === 'start' || t.status === 'starting'}
                    disabled={!s.running}
                    onClick={() =>
                      run('start', () =>
                        mutate('ai.startTunnel', kind === 'quick' ? { mode: 'quick' } : { mode: 'named', hostname, token: token.trim() || undefined }).then(() => setToken(''))
                      )
                    }
                  >
                    Turn on internet access
                  </Button>
                  {t.error ? <span className="text-xs text-danger">{t.error}</span> : null}
                </div>
              </>
            )}
          </div>
        </li>
        <li className="grid grid-cols-[28px_1fr] gap-3">
          <Step n={2} />
          <div className="space-y-2">
            <div className="font-medium text-ink">Add it in Grok</div>
            {t.mcpUrl ? (
              <div className="flex items-center gap-2">
                <code className="rounded bg-subtle px-2 py-1 text-[13px] break-all">{t.mcpUrl}</code>
                <Button size="sm" icon={Copy} onClick={() => copy(t.mcpUrl!, 'Address copied')}>
                  Copy
                </Button>
              </div>
            ) : (
              <p className="text-xs text-faint">The address appears here once internet access is on.</p>
            )}
            <p className="text-muted">
              On grok.com, open <strong>Connectors</strong> → <strong>New connector</strong> → <strong>Custom</strong>, and paste the address. If Grok asks for OAuth details, use client
              ID <code className="rounded bg-subtle px-1">grok</code> with no client secret (PKCE).
            </p>
          </div>
        </li>
        <li className="grid grid-cols-[28px_1fr] gap-3">
          <Step n={3} />
          <div>
            <div className="font-medium text-ink">Approve it here</div>
            <p className="text-muted">Grok opens a sign-in page. Alberta Books comes to the front and asks you what to allow. Nothing is shared until you approve.</p>
          </div>
        </li>
      </ol>
    </Card>
  )
}

function Step({ n }: { n: number }) {
  return <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">{n}</span>
}

function Connections({ s }: { s: AiStatus }) {
  const fb = useFeedback()
  async function revoke(id: number, name: string) {
    const ok = await fb.confirm({ title: `Remove ${name}?`, body: 'It immediately loses access. You can connect it again later.', confirmLabel: 'Remove access', danger: true })
    if (!ok) return
    mutate('ai.revoke', { id }).catch((e: Error) => fb.error(e.message))
  }
  return (
    <Card title="Connected assistants" bodyClassName="">
      {s.connections.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">None yet.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Assistant</th>
              <th className={th}>Access</th>
              <th className={th}>Last used</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {s.connections.map((c) => (
              <tr key={c.id} className={tr}>
                <td className={td}>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted">{c.kind === 'oauth' ? 'Approved sign-in' : 'Personal key'} · since {formatDateTime(c.createdAt)}</div>
                </td>
                <td className={td}>
                  <Select
                    value={c.mode}
                    className="w-52"
                    onChange={(e) => mutate('ai.setMode', { id: c.id, mode: e.target.value as Mode }).catch((err: Error) => fb.error(err.message))}
                  >
                    <option value="write">Read and make changes</option>
                    <option value="read">Read only</option>
                  </Select>
                </td>
                <td className={`${td} text-muted`}>{c.lastUsedAt ? relativeTime(c.lastUsedAt) : 'Never'}</td>
                <td className={`${td} text-right`}>
                  <Button size="sm" variant="danger" onClick={() => revoke(c.id, c.name)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function Activity() {
  const fb = useFeedback()
  const { data } = useQuery('ai.activity', { limit: 200 })
  return (
    <Card title="What assistants did" description="Every change an assistant makes, newest first. Undo posts a reversal; nothing is deleted." bodyClassName="">
      {!data ? (
        <LoadingBlock />
      ) : data.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No changes by assistants yet.</p>
      ) : (
        <table className="w-full">
          <tbody>
            {data.map((a) => (
              <tr key={a.id} className={tr}>
                <td className={`${td} w-40 whitespace-nowrap text-muted`}>{formatDateTime(a.at)}</td>
                <td className={`${td} w-36`}>
                  <Badge tone="accent">{a.actor.replace(/^ai:/, '')}</Badge>
                </td>
                <td className={td}>
                  <span className="text-muted">{a.action} {a.entity.replace(/_/g, ' ')} · </span>
                  {a.summary}
                </td>
                <td className={`${td} w-28 text-right`}>
                  {a.canUndo ? (
                    <Button size="sm" variant="ghost" icon={Undo2} onClick={() => mutate('ai.undo', { auditId: a.id }).then(() => fb.success('Undone')).catch((e: Error) => fb.error(e.message))}>
                      Undo
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function Safety() {
  return (
    <Notice tone="neutral" icon={ShieldCheck}>
      <strong>What assistants can never do:</strong> change settings or the lock date, issue or void invoices, file GST returns, restore backups, delete anything, or manage these
      connections. They draft, categorize and record; you stay in control of anything final.
    </Notice>
  )
}
