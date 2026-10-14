import { useEffect, useMemo, useState } from 'react'
import { Check, Landmark, ListFilter, Plus, Search, Trash2, Undo2, Upload, Wand2 } from 'lucide-react'
import { taxRule } from '../../../shared/taxRules'
import type { Account, BankTransaction, InvoiceSummary, StatementPreview } from '../../../shared/types'
import { FileDrop, readFile, Receipts, RuleHint } from '../components/books'
import { AccountSelect } from '../components/domain'
import { useFeedback } from '../components/feedback'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  Money,
  Notice,
  Page,
  PageHeader,
  Segmented,
  Select,
  td,
  tdNum,
  th,
  thNum,
  tr
} from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { formatDate, formatMoney } from '../lib/format'

type Tab = 'unreviewed' | 'posted' | 'excluded'

/** Accounts a bank line can go to: anything but itself and the ones the app manages (receivables, GST, retained earnings). */
const targetAllowed = (t: BankTransaction) => (a: Account) =>
  a.id !== t.accountId && !['ar', 'gst_collected', 'gst_itc', 'gst_owing', 'retained_earnings'].includes(a.role ?? '')

/** 'a:<accountId>' or 'i:<invoiceId>' */
type Choice = string

export default function BankFeed() {
  const fb = useFeedback()
  const [tab, setTab] = useState<Tab>('unreviewed')
  const [accountFilter, setAccountFilter] = useState<number | ''>('')
  const [q, setQ] = useState('')
  const [importing, setImporting] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [details, setDetails] = useState<{ t: BankTransaction; choice: Choice } | null>(null)
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [busy, setBusy] = useState<number | 'all' | null>(null)

  const accounts = useQuery('accounts.list')
  const invoices = useQuery('invoices.list')
  const counts = useQuery('bank.list', { status: 'unreviewed', limit: 5000 })
  const list = useQuery('bank.list', { status: tab, accountId: accountFilter || undefined, search: q.trim() || undefined, limit: 1000 })
  const accountList = accounts.data ?? []
  const byId = useMemo(() => new Map(accountList.map((a) => [a.id, a])), [accountList])
  const openInvoices = (invoices.data ?? []).filter((i) => ['open', 'partial', 'overdue'].includes(i.displayStatus))
  const bankAccounts = accountList.filter((a) => a.isBank && !a.archived)

  const choiceFor = (t: BankTransaction): Choice =>
    choices[t.id] ?? (t.suggestedInvoiceId ? `i:${t.suggestedInvoiceId}` : t.suggestedAccountId ? `a:${t.suggestedAccountId}` : '')

  /** Rules that need more from you (purpose, attendees) open the details dialog first. */
  const needsDetails = (choice: Choice) => {
    if (!choice.startsWith('a:')) return false
    const rule = taxRule(byId.get(Number(choice.slice(2)))?.taxRule)
    return !!(rule.needsPurpose || rule.needsAttendees)
  }

  async function post(t: BankTransaction, choice: Choice, extra: Record<string, unknown> = {}, remember = true) {
    const target = choice.startsWith('i:')
      ? { kind: 'invoice' as const, invoiceId: Number(choice.slice(2)) }
      : { kind: 'account' as const, accountId: Number(choice.slice(2)), ...extra }
    await mutate('bank.categorize', { id: t.id, target, remember })
  }

  async function postOne(t: BankTransaction) {
    const choice = choiceFor(t)
    if (!choice) return fb.error('Choose where this goes first.')
    if (needsDetails(choice)) return setDetails({ t, choice })
    setBusy(t.id)
    try {
      await post(t, choice)
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const ready = (list.data ?? []).filter((t) => tab === 'unreviewed' && choiceFor(t) && !needsDetails(choiceFor(t)))

  async function postAll() {
    setBusy('all')
    let done = 0
    const failed: string[] = []
    for (const t of ready) {
      try {
        await post(t, choiceFor(t))
        done++
      } catch (e) {
        failed.push(`${t.description}: ${(e as Error).message}`)
      }
    }
    setBusy(null)
    if (done) fb.success(`${done} transaction${done === 1 ? '' : 's'} posted`)
    if (failed.length) fb.error(failed.slice(0, 3).join(' · '))
  }

  async function undo(t: BankTransaction) {
    try {
      await mutate('bank.uncategorize', { id: t.id })
      fb.success(t.status === 'excluded' ? 'Back in the queue' : 'Undone: back in the queue')
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  async function exclude(t: BankTransaction) {
    const ok = await fb.confirm({
      title: 'Exclude this transaction?',
      body: 'Use this for duplicates or lines that are already in the books another way. Nothing is posted; you can restore it from the Excluded tab.',
      confirmLabel: 'Exclude'
    })
    if (!ok) return
    try {
      await mutate('bank.exclude', { id: t.id, reason: 'Excluded by you' })
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  const queueCount = counts.data?.length ?? 0
  const rows = list.data ?? []

  return (
    <Page wide>
      <PageHeader
        title="Bank feed"
        subtitle="Import statements from National Bank (or any bank), then categorize each line. Nothing reaches the books until you post it."
        actions={
          <>
            <Button icon={ListFilter} onClick={() => setRulesOpen(true)}>
              Rules
            </Button>
            <Button variant="primary" icon={Upload} onClick={() => setImporting(true)}>
              Import statement
            </Button>
          </>
        }
      />
      {list.error ? <ErrorNote message={list.error} /> : null}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'unreviewed', label: <>To review {queueCount ? <Badge tone="accent">{queueCount}</Badge> : null}</> },
            { value: 'posted', label: 'Posted' },
            { value: 'excluded', label: 'Excluded' }
          ]}
        />
        <div className="flex items-center gap-2">
          {bankAccounts.length > 1 ? (
            <Select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value ? Number(e.target.value) : '')} className="w-56">
              <option value="">All accounts</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          ) : null}
          <div className="relative w-60">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search description" className="pl-9" />
          </div>
          {tab === 'unreviewed' && ready.length > 1 ? (
            <Button icon={Wand2} onClick={postAll} loading={busy === 'all'}>
              Post {ready.length} with a category
            </Button>
          ) : null}
        </div>
      </div>

      {!list.data ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Landmark}
            title={tab === 'unreviewed' ? (q ? 'Nothing matches' : 'All caught up') : 'Nothing here'}
            body={
              tab === 'unreviewed'
                ? 'In National Bank online banking, download your transactions as “QuickBooks (QBO)” or CSV, then import the file here.'
                : undefined
            }
            action={
              tab === 'unreviewed' ? (
                <Button variant="primary" icon={Upload} onClick={() => setImporting(true)}>
                  Import statement
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card bodyClassName="">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Description</th>
                <th className={thNum}>Amount</th>
                <th className={`${th} w-[34%]`}>{tab === 'posted' ? 'Posted to' : tab === 'excluded' ? 'Note' : 'Category'}</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={tr}>
                  <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(t.date)}</td>
                  <td className={td}>
                    <div className="font-medium">{t.payee || t.description}</div>
                    <div className="text-xs text-muted">
                      {t.payee ? `${t.description} · ` : ''}
                      {t.accountName}
                    </div>
                  </td>
                  <td className={`${tdNum} font-medium ${t.amountCents > 0 ? 'text-good' : ''}`}>
                    {t.amountCents > 0 ? '+' : ''}
                    {formatMoney(t.amountCents)}
                  </td>
                  <td className={td}>
                    {tab === 'unreviewed' ? (
                      <div className="space-y-1">
                        <CategoryPicker
                          t={t}
                          accounts={accountList}
                          invoices={openInvoices}
                          value={choiceFor(t)}
                          onChange={(c) => setChoices((s) => ({ ...s, [t.id]: c }))}
                        />
                        {t.suggestionSource && !choices[t.id] ? <SuggestionLabel source={t.suggestionSource} /> : null}
                      </div>
                    ) : tab === 'posted' ? (
                      <span className="text-muted">{t.category ?? (t.linkKind === 'payment' ? 'Client payment' : '—')}</span>
                    ) : (
                      <span className="text-muted">{t.note || '—'}</span>
                    )}
                  </td>
                  <td className={`${td} w-44 text-right whitespace-nowrap`}>
                    {tab === 'unreviewed' ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setDetails({ t, choice: choiceFor(t) })}>
                          Details
                        </Button>
                        <Button size="sm" variant="primary" icon={Check} loading={busy === t.id} onClick={() => postOne(t)}>
                          Post
                        </Button>
                        <IconButton icon={Trash2} label="Exclude" onClick={() => exclude(t)} />
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" icon={Undo2} onClick={() => undo(t)}>
                        {tab === 'excluded' ? 'Restore' : 'Undo'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {importing ? <ImportModal bankAccounts={bankAccounts} onClose={() => setImporting(false)} /> : null}
      {rulesOpen ? <RulesModal accounts={accountList} onClose={() => setRulesOpen(false)} /> : null}
      {details ? (
        <DetailsModal
          t={details.t}
          initial={details.choice}
          accounts={accountList}
          invoices={openInvoices}
          onClose={() => setDetails(null)}
          onPost={async (choice, extra, remember) => {
            await post(details.t, choice, extra, remember)
            setDetails(null)
          }}
        />
      ) : null}
    </Page>
  )
}

function SuggestionLabel({ source }: { source: string }) {
  const label = source.startsWith('rule:')
    ? 'From your rule'
    : source === 'history'
      ? 'Same as last time'
      : source === 'invoice'
        ? 'Matches an open invoice'
        : source === 'transfer'
          ? 'Looks like a transfer between your accounts'
          : 'Suggested'
  return <div className="text-xs text-accent">{label}</div>
}

function CategoryPicker({
  t,
  accounts,
  invoices,
  value,
  onChange,
  id
}: {
  t: BankTransaction
  accounts: Account[]
  invoices: InvoiceSummary[]
  value: Choice
  onChange: (c: Choice) => void
  id?: string
}) {
  const allow = targetAllowed(t)
  const groups: [string, Account[]][] = [
    [t.amountCents < 0 ? 'Expenses' : 'Income', accounts.filter((a) => allow(a) && !a.archived && (t.amountCents < 0 ? a.type === 'expense' : a.type === 'income'))],
    ['Transfer to/from your accounts', accounts.filter((a) => allow(a) && !a.archived && a.isBank)],
    ['Owner and loans', accounts.filter((a) => allow(a) && !a.archived && !a.isBank && (a.type === 'liability' || a.type === 'equity'))],
    ['Equipment and other assets', accounts.filter((a) => allow(a) && !a.archived && !a.isBank && a.type === 'asset')],
    [t.amountCents < 0 ? 'Income' : 'Expenses', accounts.filter((a) => allow(a) && !a.archived && (t.amountCents < 0 ? a.type === 'income' : a.type === 'expense'))]
  ]
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-[13px]">
      <option value="">Choose…</option>
      {t.amountCents > 0 && invoices.length ? (
        <optgroup label="Client payment for invoice">
          {invoices.map((i) => (
            <option key={i.id} value={`i:${i.id}`}>
              {i.number} · {i.clientName} · {formatMoney(i.balanceCents)} due
            </option>
          ))}
        </optgroup>
      ) : null}
      {groups.map(([label, list]) =>
        list.length ? (
          <optgroup key={label} label={label}>
            {list.map((a) => (
              <option key={a.id} value={`a:${a.id}`}>
                {a.code} · {a.name}
              </option>
            ))}
          </optgroup>
        ) : null
      )}
    </Select>
  )
}

function DetailsModal({
  t,
  initial,
  accounts,
  invoices,
  onClose,
  onPost
}: {
  t: BankTransaction
  initial: Choice
  accounts: Account[]
  invoices: InvoiceSummary[]
  onClose: () => void
  onPost: (choice: Choice, extra: Record<string, unknown>, remember: boolean) => Promise<void>
}) {
  const fb = useFeedback()
  const [choice, setChoice] = useState(initial)
  const [gstIncluded, setGstIncluded] = useState(true)
  const [businessPct, setBusinessPct] = useState('100')
  const [purpose, setPurpose] = useState('')
  const [attendees, setAttendees] = useState('')
  const [gstNumber, setGstNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [remember, setRemember] = useState(true)
  const [saving, setSaving] = useState(false)
  const account = choice.startsWith('a:') ? accounts.find((a) => a.id === Number(choice.slice(2))) : undefined
  const rule = taxRule(account?.taxRule)
  const isExpense = account?.type === 'expense' || (account?.type === 'asset' && !account.isBank && !!account.taxRule)
  useEffect(() => setGstIncluded(rule.gst === 'taxable'), [rule.gst])

  async function save() {
    if (!choice) return fb.error('Choose where this goes.')
    const pct = Number(businessPct)
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return fb.error('Business use must be 0 to 100.')
    setSaving(true)
    try {
      await onPost(
        choice,
        isExpense
          ? {
              gstIncluded,
              businessPct: !rule.ccaClass && !rule.vehicle ? pct : undefined,
              purpose: purpose.trim() || undefined,
              attendees: attendees.trim() || undefined,
              supplierGstNumber: gstNumber.trim() || undefined,
              memo: memo.trim() || undefined
            }
          : { memo: memo.trim() || undefined },
        remember
      )
      fb.success('Posted')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={t.payee || t.description}
      description={`${formatDate(t.date)} · ${t.accountName} · ${formatMoney(t.amountCents)}`}
      footer={
        <div className="flex w-full items-center justify-between">
          {choice.startsWith('a:') ? <Checkbox label="Categorize this payee the same way next time" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> : <span />}
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={saving}>
              Post
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field label="Where does it go?">{(id) => <CategoryPicker id={id} t={t} accounts={accounts} invoices={invoices} value={choice} onChange={setChoice} />}</Field>
        {isExpense ? (
          <>
            <RuleHint ruleId={account?.taxRule} />
            <div className="grid grid-cols-2 gap-4">
              <Checkbox label="The amount includes 5% GST" checked={gstIncluded} onChange={(e) => setGstIncluded(e.target.checked)} />
              {!rule.ccaClass && !rule.vehicle ? (
                <Field label="Business use %">{(id) => <Input id={id} inputMode="numeric" value={businessPct} onChange={(e) => setBusinessPct(e.target.value)} className="w-28" />}</Field>
              ) : null}
            </div>
            {rule.needsPurpose || rule.needsAttendees ? (
              <div className="grid grid-cols-2 gap-4">
                {rule.needsPurpose ? <Field label="Business purpose">{(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}</Field> : null}
                {rule.needsAttendees ? <Field label="Who attended">{(id) => <Input id={id} value={attendees} onChange={(e) => setAttendees(e.target.value)} />}</Field> : null}
              </div>
            ) : null}
            {gstIncluded && Math.abs(t.amountCents) >= 100_00 ? (
              <Field label="Supplier’s GST number" hint="Required on purchases of $100 or more to claim the GST back.">
                {(id) => <Input id={id} value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} placeholder="123456789 RT0001" className="w-64" />}
              </Field>
            ) : null}
          </>
        ) : null}
        <Field label="Note (optional)">{(id) => <Input id={id} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">Receipt</div>
          <Receipts bankTransactionId={t.id} />
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- import

function ImportModal({ bankAccounts, onClose }: { bankAccounts: Account[]; onClose: () => void }) {
  const fb = useFeedback()
  const [accountId, setAccountId] = useState<number | ''>(bankAccounts.find((a) => a.role === 'bank')?.id ?? bankAccounts[0]?.id ?? '')
  const [preview, setPreview] = useState<StatementPreview | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(files: File[]) {
    setBusy(true)
    try {
      const { fileName, bytes } = await readFile(files[0]!)
      setPreview(await call('bank.uploadStatement', { fileName, bytes }))
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remap(patch: Partial<NonNullable<StatementPreview['mapping']>>) {
    if (!preview?.mapping) return
    const mapping = { ...preview.mapping, ...patch }
    try {
      setPreview(await call('bank.previewStatement', { token: preview.token, mapping }))
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  async function importIt() {
    if (!preview || accountId === '') return
    setBusy(true)
    try {
      const r = await mutate('bank.importStatement', { token: preview.token, bankAccountId: accountId, mapping: preview.mapping ?? undefined })
      const parts = [`${r.inserted} new transaction${r.inserted === 1 ? '' : 's'}`]
      if (r.duplicates) parts.push(`${r.duplicates} already imported`)
      if (r.autoPosted) parts.push(`${r.autoPosted} posted by your rules`)
      fb.success(`Imported: ${parts.join(', ')}`)
      if (r.balanceCheck && r.balanceCheck.bankCents !== r.balanceCheck.booksCents) {
        fb.error(
          `The bank shows ${formatMoney(r.balanceCheck.bankCents)} on ${formatDate(r.balanceCheck.asOf)}; the books show ${formatMoney(r.balanceCheck.booksCents)}. The difference closes as you categorize, or an opening balance is missing.`
        )
      }
      onClose()
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const m = preview?.mapping
  const header = preview && m ? (m.hasHeader ? preview.rows[0] ?? [] : (preview.rows[0] ?? []).map((_, i) => `Column ${i + 1}`)) : []
  const colSelect = (label: string, value: number | undefined, key: 'date' | 'description' | 'amount' | 'debit' | 'credit', optional = false) => (
    <Field label={label}>
      {(id) => (
        <Select
          id={id}
          value={value ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? undefined : Number(e.target.value)
            if (key === 'amount') void remap({ amount: v, debit: undefined, credit: undefined })
            else if (key === 'debit' || key === 'credit') void remap({ [key]: v, amount: undefined })
            else if (v !== undefined) void remap({ [key]: v })
          }}
        >
          {optional ? <option value="">—</option> : null}
          {header.map((h, i) => (
            <option key={i} value={i}>
              {h || `Column ${i + 1}`}
            </option>
          ))}
        </Select>
      )}
    </Field>
  )

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title="Import a statement"
      description="OFX, QFX or QBO files (National Bank: “QuickBooks” download) are read exactly. CSV works too: check the columns below."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={importIt} loading={busy && !!preview} disabled={!preview || preview.total === 0 || accountId === ''}>
            {preview ? `Import ${preview.total} transaction${preview.total === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Account" hint="The bank account or credit card this statement is for.">
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} className="w-80">
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!preview ? (
          <FileDrop accept=".ofx,.qfx,.qbo,.csv,.txt" label="Choose a statement file or drop it here" hint="OFX · QFX · QBO · CSV, up to 10 MB" onFiles={load} busy={busy} />
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              <span>
                <span className="font-medium text-ink">{preview.fileName}</span> <span className="text-muted">· {preview.format.toUpperCase()} · {preview.total} transactions</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Choose another file
              </Button>
            </div>
            {m ? (
              <div className="rounded-lg border border-line p-4">
                <div className="grid grid-cols-5 gap-3">
                  {colSelect('Date', m.date, 'date')}
                  {colSelect('Description', m.description, 'description')}
                  {colSelect('Amount (one column)', m.amount, 'amount', true)}
                  {colSelect('Money out', m.debit, 'debit', true)}
                  {colSelect('Money in', m.credit, 'credit', true)}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-5">
                  <Field label="Date format" className="w-48">
                    {(id) => (
                      <Select id={id} value={m.dateFormat} onChange={(e) => void remap({ dateFormat: e.target.value as 'ymd' | 'mdy' | 'dmy' })}>
                        <option value="ymd">2026-03-31</option>
                        <option value="mdy">03/31/2026 (month first)</option>
                        <option value="dmy">31/03/2026 (day first)</option>
                      </Select>
                    )}
                  </Field>
                  <Checkbox label="First row is a header" checked={m.hasHeader} onChange={(e) => void remap({ hasHeader: e.target.checked })} />
                  <Checkbox label="Purchases show as positive (credit card)" checked={!!m.flipSigns} onChange={(e) => void remap({ flipSigns: e.target.checked })} />
                </div>
              </div>
            ) : null}
            {preview.warnings.length ? (
              <Notice tone="warn">
                {preview.warnings.slice(0, 5).map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </Notice>
            ) : null}
            <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
              <table className="w-full">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>Description</th>
                    <th className={thNum}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((s, i) => (
                    <tr key={i} className={tr}>
                      <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(s.date)}</td>
                      <td className={td}>{s.description}</td>
                      <td className={tdNum}>
                        <Money cents={s.amountCents} className={s.amountCents > 0 ? 'text-good' : ''} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">Positive = money in. Lines already imported are skipped automatically.</p>
          </>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- rules

function RulesModal({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const fb = useFeedback()
  const rules = useQuery('bank.rules')
  const [pattern, setPattern] = useState('')
  const [direction, setDirection] = useState<'any' | 'in' | 'out'>('out')
  const [accountId, setAccountId] = useState<number | ''>('')
  const [autoPost, setAutoPost] = useState(false)
  const [saving, setSaving] = useState(false)

  async function add() {
    if (accountId === '') return fb.error('Choose a category.')
    setSaving(true)
    try {
      await mutate('bank.saveRule', { pattern, direction, accountId, autoPost })
      setPattern('')
      fb.success('Rule added')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} width="lg" title="Bank rules" description="Lines whose description contains the text get this category. Rules come before what you chose last time.">
      <div className="grid gap-4">
        {(rules.data ?? []).length ? (
          <div className="rounded-lg border border-line">
            <table className="w-full">
              <tbody>
                {(rules.data ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className={td}>
                      <span className="font-medium">“{r.pattern}”</span>
                      <span className="ml-2 text-xs text-muted">{r.direction === 'in' ? 'money in' : r.direction === 'out' ? 'money out' : 'any direction'}</span>
                    </td>
                    <td className={`${td} text-muted`}>{r.accountName}</td>
                    <td className={td}>{r.autoPost ? <Badge tone="accent">Posts automatically</Badge> : null}</td>
                    <td className={`${td} w-10`}>
                      <IconButton icon={Trash2} label="Delete rule" onClick={() => mutate('bank.deleteRule', { id: r.id }).catch((e: Error) => fb.error(e.message))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">No rules yet. Posting a line with “same way next time” also teaches the app.</p>
        )}
        <div className="grid grid-cols-[1fr_140px_1fr] items-end gap-3 rounded-lg bg-subtle p-4">
          <Field label="Description contains">{(id) => <Input id={id} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. TELUS" />}</Field>
          <Field label="Direction">
            {(id) => (
              <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                <option value="out">Money out</option>
                <option value="in">Money in</option>
                <option value="any">Either</option>
              </Select>
            )}
          </Field>
          <Field label="Category">
            {(id) => <AccountSelect id={id} accounts={accounts} allow={(a) => !a.isBank && !a.role} value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} />}
          </Field>
          <Checkbox className="col-span-2" label="Post automatically, without review" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
          <Button icon={Plus} onClick={add} loading={saving} disabled={pattern.trim().length < 2}>
            Add rule
          </Button>
        </div>
      </div>
    </Modal>
  )
}
