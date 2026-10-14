import { useState } from 'react'
import { CheckCircle2, Plus, Trash2 } from 'lucide-react'
import type { MigrationResult, PendingMigration } from '../../../shared/types'
import { FileDrop, readFile } from '../components/books'
import { AccountSelect } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Button, Card, Field, IconButton, Input, MoneyInput, Notice, Page, PageHeader, Segmented, td, tdNum, th, thNum, tr } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { formatDate, formatMoney, parseMoney } from '../lib/format'

type Source = 'quickbooks' | 'zoho' | 'other'

const HOW: Record<Source, string[]> = {
  quickbooks: [
    'QuickBooks Online: Reports → search “Journal” → set the date range → Export → Export to Excel (or CSV).',
    'QuickBooks Desktop: Reports → Accountant & Taxes → Journal → set the dates → Excel → Create new worksheet.'
  ],
  zoho: ['Zoho Books: Reports → Accountant → Journal Report → choose the dates → Export → XLSX or CSV.'],
  other: ['Any journal or general ledger export with a date, an account, and debit/credit (or amount) columns.']
}

export default function Migrate() {
  return (
    <Page>
      <PageHeader title="Move from QuickBooks or Zoho" subtitle="Bring your history in. Recommended: opening balances at your last year end, then this year’s transactions." />
      <div className="space-y-5">
        <OpeningBalances />
        <ImportJournal />
      </div>
    </Page>
  )
}

function ImportJournal() {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const [source, setSource] = useState<Source>('zoho')
  const [pending, setPending] = useState<PendingMigration | null>(null)
  const [mapping, setMapping] = useState<Record<string, number | ''>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function load(files: File[]) {
    setBusy('load')
    try {
      const { fileName, bytes } = await readFile(files[0]!)
      const p = await call('migration.uploadFile', { fileName, bytes })
      setPending(p)
      setMapping(Object.fromEntries(p.analysis.accounts.map((a) => [a.name, a.accountId ?? ''])))
      setResult(null)
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function run(dryRun: boolean) {
    if (!pending) return
    const missing = Object.entries(mapping).filter(([, v]) => v === '')
    if (missing.length) return fb.error(`Choose an account for: ${missing.slice(0, 5).map(([k]) => k).join(', ')}`)
    setBusy(dryRun ? 'dry' : 'import')
    try {
      const r = await (dryRun ? call : mutate)('migration.import', {
        token: pending.token,
        source,
        mapping: mapping as Record<string, number>,
        from: from || undefined,
        to: to || undefined,
        dryRun
      })
      setResult(r)
      if (!dryRun) {
        fb.success(`${r.imported} transactions imported`)
        setPending(null)
      }
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const a = pending?.analysis
  return (
    <Card title="Import transactions" description="From a journal export. Each source account is matched to one of yours; you can check everything before anything is saved.">
      <div className="space-y-4">
        <Segmented
          value={source}
          onChange={setSource}
          options={[
            { value: 'zoho', label: 'Zoho Books' },
            { value: 'quickbooks', label: 'QuickBooks' },
            { value: 'other', label: 'Other' }
          ]}
        />
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{HOW[source].map((h) => <li key={h}>{h}</li>)}</ul>
        {!pending ? (
          <FileDrop accept=".csv,.txt,.xlsx" label="Choose the export or drop it here" hint="CSV or Excel (.xlsx), up to 20 MB" onFiles={load} busy={busy === 'load'} />
        ) : (
          <>
            <div className="flex items-center justify-between rounded-lg bg-subtle px-4 py-3 text-sm">
              <span>
                <span className="font-medium text-ink">{pending.fileName}</span>
                <span className="text-muted">
                  {' '}
                  · {a!.transactions} transactions · {a!.lines} lines · {formatDate(a!.from)} to {formatDate(a!.to)}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                Choose another file
              </Button>
            </div>
            {a!.unbalanced ? <Notice tone="warn">{a!.unbalanced} transaction(s) don’t balance and will be skipped.</Notice> : null}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Only from (optional)">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="Only to (optional)">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            </div>
            <div className="max-h-[420px] overflow-y-auto rounded-lg border border-line">
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr>
                    <th className={th}>In {source === 'zoho' ? 'Zoho' : source === 'quickbooks' ? 'QuickBooks' : 'the file'}</th>
                    <th className={th}>Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {a!.accounts.map((acc) => (
                    <tr key={acc.name} className={tr}>
                      <td className={td}>{acc.name}</td>
                      <td className={`${td} w-[55%]`}>
                        <AccountSelect
                          accounts={accounts.data ?? []}
                          value={mapping[acc.name] ?? ''}
                          onChange={(e) => setMapping((m) => ({ ...m, [acc.name]: e.target.value ? Number(e.target.value) : '' }))}
                          className="h-8 text-[13px]"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result ? (
              <Notice tone={result.skipped.length ? 'warn' : 'good'} icon={CheckCircle2}>
                {result.dryRun ? 'Check passed: ' : 'Done: '}
                {result.imported} transactions {result.dryRun ? 'would be imported' : 'imported'}
                {result.skipped.length ? `, ${result.skipped.length} skipped (${result.skipped.slice(0, 3).map((s) => `${s.key}: ${s.reason}`).join('; ')})` : ''}.
              </Notice>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button onClick={() => run(true)} loading={busy === 'dry'}>
                Check first
              </Button>
              <Button variant="primary" onClick={() => run(false)} loading={busy === 'import'}>
                Import
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

interface Line {
  accountId: number | ''
  debit: string
  credit: string
}

function OpeningBalances() {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const [date, setDate] = useState('')
  const [lines, setLines] = useState<Line[]>([
    { accountId: '', debit: '', credit: '' },
    { accountId: '', debit: '', credit: '' }
  ])
  const [saving, setSaving] = useState(false)
  const cents = (s: string) => (s.trim() ? parseMoney(s) : 0)
  const totalD = lines.reduce((s, l) => s + (cents(l.debit) ?? 0), 0)
  const totalC = lines.reduce((s, l) => s + (cents(l.credit) ?? 0), 0)
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)))

  async function save() {
    if (!date) return fb.error('Enter the date of the balances (your last year end, e.g. August 31).')
    const used = lines.filter((l) => l.accountId !== '' && (cents(l.debit) || cents(l.credit)))
    if (used.some((l) => cents(l.debit) === null || cents(l.credit) === null)) return fb.error('Check the amounts.')
    if (totalD !== totalC) return fb.error('Debits and credits must be equal, like on the trial balance.')
    setSaving(true)
    try {
      await mutate('migration.openingBalances', {
        date,
        balances: used.map((l) => ({ accountId: l.accountId as number, debitCents: cents(l.debit)!, creditCents: cents(l.credit)! }))
      })
      fb.success('Opening balances entered')
      setLines([{ accountId: '', debit: '', credit: '' }])
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="Opening balances"
      description="Copy the closing trial balance from your accountant’s last year-end (or from QuickBooks/Zoho: Reports → Trial Balance as of your year end). Entered once, as one journal entry."
      bodyClassName=""
    >
      <div className="flex items-end gap-4 border-b border-line px-5 py-4">
        <Field label="As of" className="w-48">
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <p className="pb-2 text-xs text-muted">Usually your last fiscal year end. The next day is the first day in these books.</p>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}>Account</th>
            <th className={thNum}>Debit</th>
            <th className={thNum}>Credit</th>
            <th className={th}></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className={tr}>
              <td className={td}>
                <AccountSelect accounts={accounts.data ?? []} allow={(a) => a.type !== 'income' && a.type !== 'expense'} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value ? Number(e.target.value) : '' })} className="h-8 text-[13px]" />
              </td>
              <td className={`${td} w-44`}>
                <MoneyInput value={l.debit} onChange={(e) => set(i, { debit: e.target.value })} />
              </td>
              <td className={`${td} w-44`}>
                <MoneyInput value={l.credit} onChange={(e) => set(i, { credit: e.target.value })} />
              </td>
              <td className={`${td} w-10`}>
                <IconButton icon={Trash2} label="Remove line" onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} />
              </td>
            </tr>
          ))}
          <tr className={tr}>
            <td className={td}>
              <Button size="sm" variant="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, { accountId: '', debit: '', credit: '' }])}>
                Add line
              </Button>
            </td>
            <td className={`${tdNum} font-semibold`}>{formatMoney(totalD)}</td>
            <td className={`${tdNum} font-semibold`}>{formatMoney(totalC)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t border-line px-5 py-3">
        <span className={`text-sm ${totalD === totalC ? 'text-muted' : 'text-danger'}`}>
          {totalD === totalC ? 'Balanced. Income and expense accounts are already closed into retained earnings at year end.' : `Difference: ${formatMoney(totalD - totalC)}`}
        </span>
        <Button variant="primary" onClick={save} loading={saving}>
          Enter opening balances
        </Button>
      </div>
    </Card>
  )
}
