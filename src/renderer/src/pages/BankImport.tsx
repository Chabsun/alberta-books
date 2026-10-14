import { useMemo, useState } from 'react'
import { FileUp, Landmark, RotateCcw } from 'lucide-react'
import { parseCsvDate, type CsvDateFormat } from '../../../shared/dates'
import type { Account, CsvFile, InvoiceSummary } from '../../../shared/types'
import { TYPE_LABELS } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, Checkbox, EmptyState, Field, LoadingBlock, Notice, Page, PageHeader, Select, cx } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { formatDate, formatMoney, parseMoney } from '../lib/format'

interface Mapping {
  hasHeader: boolean
  date: number
  description: number
  amountMode: 'single' | 'split'
  amount: number
  debit: number
  credit: number
  dateFormat: CsvDateFormat
  flip: boolean
}

interface Row {
  index: number
  date: string | null
  description: string
  amountCents: number | null
}

// Accounts whose purchases normally have no GST in Canada.
const NO_GST_GIFI = new Set(['8690', '8710', '8715', '9990'])

function findCol(headers: string[], words: RegExp): number {
  return headers.findIndex((h) => words.test(h.trim().toLowerCase()))
}

function guessMapping(file: CsvFile): Mapping {
  const headers = file.headers
  const looksLikeHeader = headers.every((h) => !/^\s*[\d$(-]/.test(h) || h.trim() === '')
  const lower = headers.map((h) => h.toLowerCase())
  let date = findCol(lower, /date|posted/)
  let description = findCol(lower, /desc|detail|payee|memo|name|transaction$/)
  const amount = findCol(lower, /^amount|cad\$?|^amt/)
  const debit = findCol(lower, /debit|withdraw|money out|paid out/)
  const credit = findCol(lower, /credit|deposit|money in|paid in/)
  if (!looksLikeHeader || date < 0) date = 0
  if (!looksLikeHeader || description < 0) description = 1
  const split = amount < 0 && debit >= 0 && credit >= 0
  const sample = (looksLikeHeader ? file.rows : [file.headers, ...file.rows]).slice(0, 50).map((r) => r[date] ?? '')
  const formats: CsvDateFormat[] = ['ymd', 'mdy', 'dmy']
  const dateFormat = formats.find((f) => sample.every((s) => parseCsvDate(s, f) !== null)) ?? 'mdy'
  return {
    hasHeader: looksLikeHeader,
    date,
    description,
    amountMode: split || (!looksLikeHeader && headers.length >= 4 && amount < 0) ? 'split' : 'single',
    amount: amount >= 0 ? amount : 2,
    debit: debit >= 0 ? debit : 2,
    credit: credit >= 0 ? credit : 3,
    dateFormat,
    flip: false
  }
}

function toRows(file: CsvFile, m: Mapping): Row[] {
  const raw = m.hasHeader ? file.rows : [file.headers, ...file.rows]
  return raw.map((r, index) => {
    let amountCents: number | null
    if (m.amountMode === 'single') amountCents = parseMoney(r[m.amount] ?? '')
    else {
      const d = (r[m.debit] ?? '').trim() ? parseMoney(r[m.debit]) : 0
      const c = (r[m.credit] ?? '').trim() ? parseMoney(r[m.credit]) : 0
      amountCents = d === null || c === null ? null : c - Math.abs(d)
    }
    if (amountCents !== null && m.flip) amountCents = -amountCents
    return {
      index,
      date: parseCsvDate(r[m.date] ?? '', m.dateFormat),
      description: (r[m.description] ?? '').trim(),
      amountCents
    }
  })
}

export default function BankImport() {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const invoices = useQuery('invoices.list')
  const [bankId, setBankId] = useState<number | ''>('')
  const [file, setFile] = useState<CsvFile | null>(null)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [choice, setChoice] = useState<Record<number, string>>({})
  const [gst, setGst] = useState<Record<number, boolean>>({})
  const [posting, setPosting] = useState(false)

  const list = accounts.data ?? []
  const banks = list.filter((a) => a.isBank && !a.archived)
  const bank = bankId === '' ? banks[0] : banks.find((b) => b.id === bankId)
  const rows = useMemo(() => (file && mapping ? toRows(file, mapping) : []), [file, mapping])
  const openInvoices = (invoices.data ?? []).filter((i) => i.status === 'issued' && i.balanceCents > 0)

  async function pick() {
    try {
      const f = await call('import.pickCsv')
      if (!f) return
      setFile(f)
      setMapping(guessMapping(f))
      setChoice({})
      setGst({})
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  function choose(row: Row, value: string) {
    setChoice((c) => ({ ...c, [row.index]: value }))
    if (value.startsWith('a:')) {
      const acc = list.find((a) => a.id === Number(value.slice(2)))
      const defaultGst = !!acc && row.amountCents !== null && row.amountCents < 0 && acc.type === 'expense' && !NO_GST_GIFI.has(acc.gifiCode ?? '')
      setGst((g) => ({ ...g, [row.index]: defaultGst }))
    }
  }

  const ready = rows.filter((r) => choice[r.index] && r.date && r.amountCents && r.description)
  const invalid = rows.filter((r) => !r.date || r.amountCents === null || !r.description)

  async function post() {
    if (!bank || ready.length === 0) return
    setPosting(true)
    try {
      const result = await mutate('import.post', {
        bankAccountId: bank.id,
        rows: ready.map((r) => {
          const v = choice[r.index]
          return {
            date: r.date!,
            description: r.description,
            amountCents: r.amountCents!,
            target: v.startsWith('i:')
              ? { kind: 'invoice' as const, invoiceId: Number(v.slice(2)) }
              : { kind: 'account' as const, accountId: Number(v.slice(2)), gstIncluded: !!gst[r.index] }
          }
        })
      })
      fb.success(
        `${result.posted} transaction${result.posted === 1 ? '' : 's'} recorded` +
          (result.skippedDuplicates ? `, ${result.skippedDuplicates} already imported and skipped` : '')
      )
      setChoice((c) => {
        const next = { ...c }
        for (const r of ready) delete next[r.index]
        return next
      })
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setPosting(false)
    }
  }

  if (!accounts.data) return <LoadingBlock />

  return (
    <Page wide>
      <PageHeader
        title="Bank import"
        subtitle="Download a CSV statement from your bank’s website, then sort each transaction into the right category."
        actions={
          file ? (
            <>
              <Button icon={RotateCcw} onClick={() => setFile(null)}>
                Start over
              </Button>
              <Button variant="primary" onClick={post} loading={posting} disabled={ready.length === 0}>
                Record {ready.length} transaction{ready.length === 1 ? '' : 's'}
              </Button>
            </>
          ) : null
        }
      />

      {!file || !mapping ? (
        <Card>
          <EmptyState
            icon={Landmark}
            title="Import a bank or credit card statement"
            body="Already-imported transactions are recognized and skipped, so overlapping statements are safe."
            action={
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center gap-2">
                  <Select value={bank?.id ?? ''} onChange={(e) => setBankId(Number(e.target.value))} className="w-64" aria-label="Account">
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                  <Button variant="primary" icon={FileUp} onClick={pick}>
                    Choose CSV file…
                  </Button>
                </div>
              </div>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          <Card title={file.fileName} description={`${rows.length} rows · importing into ${bank?.name}`}>
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <ColumnSelect label="Date column" headers={file.headers} hasHeader={mapping.hasHeader} value={mapping.date} onChange={(v) => setMapping({ ...mapping, date: v })} />
              <Field label="Date format">
                {(id) => (
                  <Select id={id} value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as CsvDateFormat })}>
                    <option value="ymd">YYYY-MM-DD</option>
                    <option value="mdy">MM/DD/YYYY</option>
                    <option value="dmy">DD/MM/YYYY</option>
                  </Select>
                )}
              </Field>
              <ColumnSelect label="Description column" headers={file.headers} hasHeader={mapping.hasHeader} value={mapping.description} onChange={(v) => setMapping({ ...mapping, description: v })} />
              <Field label="Amounts">
                {(id) => (
                  <Select id={id} value={mapping.amountMode} onChange={(e) => setMapping({ ...mapping, amountMode: e.target.value as Mapping['amountMode'] })}>
                    <option value="single">One column</option>
                    <option value="split">In / out columns</option>
                  </Select>
                )}
              </Field>
              {mapping.amountMode === 'single' ? (
                <ColumnSelect label="Amount column" headers={file.headers} hasHeader={mapping.hasHeader} value={mapping.amount} onChange={(v) => setMapping({ ...mapping, amount: v })} />
              ) : (
                <>
                  <ColumnSelect label="Money out column" headers={file.headers} hasHeader={mapping.hasHeader} value={mapping.debit} onChange={(v) => setMapping({ ...mapping, debit: v })} />
                  <ColumnSelect label="Money in column" headers={file.headers} hasHeader={mapping.hasHeader} value={mapping.credit} onChange={(v) => setMapping({ ...mapping, credit: v })} />
                </>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-6">
              <Checkbox label="First row is column names" checked={mapping.hasHeader} onChange={(e) => setMapping({ ...mapping, hasHeader: e.target.checked })} />
              <Checkbox label="Flip signs (money out shows as positive in this file)" checked={mapping.flip} onChange={(e) => setMapping({ ...mapping, flip: e.target.checked })} />
            </div>
            {invalid.length > 0 ? (
              <div className="mt-4">
                <Notice tone="warn">
                  {invalid.length} row{invalid.length === 1 ? '' : 's'} can’t be read with these settings (shown greyed out). Check the date format and columns.
                </Notice>
              </div>
            ) : null}
          </Card>

          <Card title="Transactions" description="Leave a row on “Skip” to leave it out. Deposits can be matched to an unpaid invoice." bodyClassName="">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="w-32 px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Description</th>
                  <th className="w-36 px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="w-[340px] px-4 py-2.5 text-left font-medium">Category</th>
                  <th className="w-28 px-4 py-2.5 text-left font-medium">GST incl.</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const bad = !r.date || r.amountCents === null || !r.description
                  const v = choice[r.index] ?? ''
                  return (
                    <tr key={r.index} className={cx('border-t border-line', bad && 'opacity-40', v && 'bg-accent-soft/30')}>
                      <td className="px-4 py-2 text-sm whitespace-nowrap text-muted">{r.date ? formatDate(r.date) : '?'}</td>
                      <td className="px-4 py-2 text-sm">{r.description || '?'}</td>
                      <td className={cx('px-4 py-2 text-right text-sm tabular whitespace-nowrap', r.amountCents !== null && r.amountCents > 0 && 'text-good')}>
                        {r.amountCents === null ? '?' : formatMoney(r.amountCents)}
                      </td>
                      <td className="px-4 py-1.5">
                        {bad ? null : (
                          <CategorySelect
                            accounts={list.filter((a) => a.id !== bank?.id)}
                            invoices={r.amountCents! > 0 && bank?.type === 'asset' ? openInvoices : []}
                            value={v}
                            onChange={(val) => choose(r, val)}
                          />
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {v.startsWith('a:') ? (
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            checked={!!gst[r.index]}
                            onChange={(e) => setGst((g) => ({ ...g, [r.index]: e.target.checked }))}
                            aria-label="Amount includes 5% GST"
                          />
                        ) : v.startsWith('i:') ? (
                          <Badge tone="good">Payment</Badge>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </Page>
  )
}

function ColumnSelect({ label, headers, hasHeader, value, onChange }: { label: string; headers: string[]; hasHeader: boolean; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {hasHeader && h.trim() ? h : `Column ${i + 1}`}
            </option>
          ))}
        </Select>
      )}
    </Field>
  )
}

function CategorySelect({ accounts, invoices, value, onChange }: { accounts: Account[]; invoices: InvoiceSummary[]; value: string; onChange: (v: string) => void }) {
  const types = ['expense', 'income', 'asset', 'liability', 'equity'] as const
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={cx('h-8 text-[13px]', !value && 'text-faint')} aria-label="Category">
      <option value="">Skip</option>
      {invoices.length > 0 ? (
        <optgroup label="Payment for invoice">
          {invoices.map((i) => (
            <option key={i.id} value={`i:${i.id}`}>
              {i.number} · {i.clientName} · {formatMoney(i.balanceCents)} owing
            </option>
          ))}
        </optgroup>
      ) : null}
      {types.map((t) => {
        const group = accounts.filter((a) => a.type === t && !a.archived && a.role !== 'ar')
        if (!group.length) return null
        return (
          <optgroup key={t} label={TYPE_LABELS[t]}>
            {group.map((a) => (
              <option key={a.id} value={`a:${a.id}`}>
                {a.name}
              </option>
            ))}
          </optgroup>
        )
      })}
    </Select>
  )
}
