import { useEffect, useRef, useState } from 'react'
import { FolderOpen, HardDriveDownload, History, Lock, ShieldCheck } from 'lucide-react'
import type { Settings as SettingsT } from '../../../shared/types'
import { useFeedback } from '../components/feedback'
import { Button, Card, Field, Input, LoadingBlock, Page, PageHeader, Select, Textarea } from '../components/ui'
import { call, invalidate, mutate, useQuery } from '../lib/api'
import { MONTHS, formatBytes, formatDate, formatDateTime } from '../lib/format'
import { queryParam, usePath } from '../lib/router'

type Form = Pick<
  SettingsT,
  'companyName' | 'address' | 'email' | 'phone' | 'gstNumber' | 'fiscalYearEndMonth' | 'invoicePrefix' | 'nextInvoiceNumber' | 'paymentTermsDays' | 'invoiceFooter'
>

export default function Settings() {
  const path = usePath()
  const fb = useFeedback()
  const settings = useQuery('settings.get')
  const info = useQuery('app.info')
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const backupsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (settings.data && !form) {
      const { lockDate: _l, backupDir: _b, ...rest } = settings.data
      setForm(rest)
    }
  }, [settings.data, form])

  useEffect(() => {
    if (form && queryParam(path, 'section') === 'backups') backupsRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [form, path])

  if (!settings.data || !form) return <LoadingBlock />
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v })

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await mutate('settings.update', form!)
      fb.success('Settings saved')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Settings"
        actions={
          <Button variant="primary" onClick={save} loading={saving}>
            Save changes
          </Button>
        }
      />
      {error ? <p className="mb-4 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}

      <div className="space-y-6">
        <Card title="Company" description="Shown on your invoices.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Legal name">{(id) => <Input id={id} value={form.companyName} onChange={(e) => set('companyName', e.target.value)} />}</Field>
            <Field label="GST registration number" hint="Format: 123456789 RT0001. Required on invoices so clients can claim the GST.">
              {(id) => <Input id={id} value={form.gstNumber} onChange={(e) => set('gstNumber', e.target.value)} placeholder="123456789 RT0001" />}
            </Field>
            <Field label="Email">{(id) => <Input id={id} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />}</Field>
            <Field label="Phone">{(id) => <Input id={id} value={form.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
            <Field label="Address" className="sm:col-span-2">
              {(id) => <Textarea id={id} rows={3} value={form.address} onChange={(e) => set('address', e.target.value)} placeholder={'123 Main Street SW\nCalgary, AB  T2P 1A1'} />}
            </Field>
          </div>
        </Card>

        <Card title="Invoices">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Number prefix">{(id) => <Input id={id} value={form.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value)} />}</Field>
            <Field label="Next number">
              {(id) => <Input id={id} inputMode="numeric" value={String(form.nextInvoiceNumber)} onChange={(e) => set('nextInvoiceNumber', Number(e.target.value.replace(/\D/g, '')) || 1)} />}
            </Field>
            <Field label="Payment terms (days)">
              {(id) => <Input id={id} inputMode="numeric" value={String(form.paymentTermsDays)} onChange={(e) => set('paymentTermsDays', Number(e.target.value.replace(/\D/g, '')) || 0)} />}
            </Field>
            <Field label="Footer" className="sm:col-span-3">
              {(id) => <Input id={id} value={form.invoiceFooter} onChange={(e) => set('invoiceFooter', e.target.value)} />}
            </Field>
          </div>
        </Card>

        <Card title="Fiscal year">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Year ends on the last day of" hint="From your articles of incorporation or first T2.">
              {(id) => (
                <Select id={id} value={form.fiscalYearEndMonth} onChange={(e) => set('fiscalYearEndMonth', Number(e.target.value))}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Card>

        <LockDateCard lockDate={settings.data.lockDate} />

        <div ref={backupsRef}>
          <BackupsCard />
        </div>

        <Card title="About">
          <dl className="grid gap-2 text-sm sm:grid-cols-[160px_1fr]">
            <dt className="text-muted">Version</dt>
            <dd>{info.data?.version ?? '…'}</dd>
            <dt className="text-muted">Your data file</dt>
            <dd className="break-all text-muted">{info.data?.databasePath ?? '…'}</dd>
            <dt className="text-muted">Privacy</dt>
            <dd className="flex items-center gap-1.5 text-muted">
              <ShieldCheck className="size-4 text-good" /> Everything stays on this computer. The app makes no internet connections.
            </dd>
          </dl>
        </Card>
      </div>
    </Page>
  )
}

function LockDateCard({ lockDate }: { lockDate: string | null }) {
  const fb = useFeedback()
  const [value, setValue] = useState(lockDate ?? '')
  useEffect(() => setValue(lockDate ?? ''), [lockDate])

  async function apply(next: string | null) {
    if (next === null || (lockDate && next < lockDate)) {
      const ok = await fb.confirm({
        title: next === null ? 'Remove the lock date?' : 'Move the lock date earlier?',
        body: 'This reopens periods you may already have filed with CRA. Only do this if your accountant asks you to.',
        confirmLabel: 'Unlock',
        danger: true
      })
      if (!ok) return
    }
    try {
      await mutate('settings.update', { lockDate: next })
      fb.success(next ? `Books locked up to ${formatDate(next)}` : 'Lock date removed')
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  return (
    <Card title="Lock date" description="Nothing can be recorded on or before this date. Filing a GST return sets it automatically.">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Books locked up to">{(id) => <Input id={id} type="date" value={value} onChange={(e) => setValue(e.target.value)} className="w-44" />}</Field>
        <Button icon={Lock} onClick={() => apply(value || null)} disabled={(value || null) === lockDate}>
          {value ? 'Set lock date' : 'Remove lock date'}
        </Button>
        {lockDate ? (
          <Button variant="ghost" onClick={() => apply(null)}>
            Remove
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function BackupsCard() {
  const fb = useFeedback()
  const status = useQuery('backup.status')
  const [busy, setBusy] = useState<string | null>(null)

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind)
    try {
      await fn()
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const s = status.data
  return (
    <Card
      title="Backups"
      description="A full copy of your books is saved every day you use the app and every time you quit. The newest 60 are kept."
      actions={
        <Button
          icon={HardDriveDownload}
          loading={busy === 'now'}
          onClick={() =>
            run('now', async () => {
              await mutate('backup.now')
              fb.success('Backup saved')
            })
          }
        >
          Back up now
        </Button>
      }
    >
      {!s ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-line p-4">
              <div className="text-[13px] font-medium">Automatic backups</div>
              <div className="mt-1 text-xs break-all text-muted">{s.autoBackupDir}</div>
              <Button size="sm" className="mt-3" icon={FolderOpen} onClick={() => run('open', () => call('backup.openFolder'))}>
                Show in folder
              </Button>
            </div>
            <div className="rounded-lg border border-line p-4">
              <div className="text-[13px] font-medium">Second copy (recommended)</div>
              <div className="mt-1 text-xs break-all text-muted">
                {s.extraBackupDir ?? 'Not set. Choose a folder in iCloud Drive, Dropbox or OneDrive so your books survive losing this computer.'}
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" loading={busy === 'folder'} onClick={() => run('folder', () => mutate('backup.chooseFolder'))}>
                  {s.extraBackupDir ? 'Change folder' : 'Choose folder'}
                </Button>
                {s.extraBackupDir ? (
                  <Button size="sm" variant="ghost" onClick={() => run('clear', () => mutate('backup.chooseFolder', { clear: true }))}>
                    Stop
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-medium">Recent backups</div>
              <Button
                size="sm"
                variant="ghost"
                icon={History}
                loading={busy === 'restore'}
                onClick={() =>
                  run('restore', async () => {
                    const r = await call('backup.restore')
                    if (r.restored) {
                      invalidate()
                      fb.success('Backup restored')
                    }
                  })
                }
              >
                Restore from a backup…
              </Button>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
              {s.backups.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted">No backups yet.</div>
              ) : (
                <ul className="text-sm">
                  {s.backups.map((b) => (
                    <li key={b.name} className="flex justify-between border-t border-line px-4 py-2 first:border-t-0">
                      <span>{formatDateTime(b.createdAt)}</span>
                      <span className="text-muted tabular">{formatBytes(b.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
