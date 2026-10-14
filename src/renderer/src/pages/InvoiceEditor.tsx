import { useEffect, useMemo, useState } from 'react'
import { Plus, Send, Trash2, UserPlus, X } from 'lucide-react'
import type { Account, Invoice } from '../../../shared/types'
import { addDays, todayIso } from '../../../shared/dates'
import { GST_RATE_BPS, gstOn, lineAmount } from '../../../shared/money'
import { ClientModal } from '../components/ClientModal'
import { BackLink } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Button, Card, ErrorNote, Field, IconButton, Input, LoadingBlock, Money, MoneyInput, Page, PageHeader, Select, Textarea, cx } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { centsToPlain, formatMoney, formatQuantity, parseMoney, parseQuantity } from '../lib/format'
import { navigate } from '../lib/router'

interface LineDraft {
  key: number
  description: string
  qty: string
  price: string
  taxable: boolean
  accountId: number | ''
}

let keySeq = 1
const blankLine = (accountId: number | ''): LineDraft => ({ key: keySeq++, description: '', qty: '1', price: '', taxable: true, accountId })

export default function InvoiceEditor({ id }: { id?: number }) {
  const fb = useFeedback()
  const settings = useQuery('settings.get')
  const clients = useQuery('clients.list')
  const accounts = useQuery('accounts.list')
  const [loaded, setLoaded] = useState<Invoice | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [clientId, setClientId] = useState<number | ''>('')
  const [issueDate, setIssueDate] = useState(todayIso())
  const [dueDate, setDueDate] = useState(todayIso())
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([])
  const [clientModal, setClientModal] = useState(false)
  const [busy, setBusy] = useState<'save' | 'issue' | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [initialized, setInitialized] = useState(false)

  const incomeAccounts = useMemo(() => (accounts.data ?? []).filter((a) => a.type === 'income' && !a.archived), [accounts.data])
  const salesId = incomeAccounts.find((a) => a.role === 'sales')?.id ?? ''

  // Load an existing draft, or start a new one with the default payment terms.
  useEffect(() => {
    if (initialized || !settings.data || !accounts.data) return
    if (id === undefined) {
      setDueDate(addDays(todayIso(), settings.data.paymentTermsDays))
      setLines([blankLine(salesId)])
      setInitialized(true)
      return
    }
    call('invoices.get', { id })
      .then((inv) => {
        if (inv.status !== 'draft') return navigate(`/invoices/${inv.id}`)
        setLoaded(inv)
        setClientId(inv.clientId)
        setIssueDate(inv.issueDate)
        setDueDate(inv.dueDate)
        setNotes(inv.notes)
        setLines(
          inv.lines.map((l) => ({
            key: keySeq++,
            description: l.description,
            qty: formatQuantity(l.qtyMilli),
            price: centsToPlain(l.unitPriceCents),
            taxable: l.taxable,
            accountId: l.accountId
          }))
        )
        setInitialized(true)
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [id, initialized, settings.data, accounts.data, salesId])

  const computed = lines.map((l) => {
    const qty = parseQuantity(l.qty)
    const price = parseMoney(l.price)
    return { qty, price, amount: qty !== null && price !== null ? lineAmount(qty, price) : null }
  })
  const subtotal = computed.reduce((s, c) => s + (c.amount ?? 0), 0)
  const taxable = computed.reduce((s, c, i) => s + (lines[i].taxable ? (c.amount ?? 0) : 0), 0)
  const gst = gstOn(taxable, GST_RATE_BPS)
  const total = subtotal + gst

  function update(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (clientId === '') e.client = 'Choose a client.'
    if (dueDate < issueDate) e.dueDate = 'The due date cannot be before the invoice date.'
    lines.forEach((l, i) => {
      if (!l.description.trim()) e[`desc-${l.key}`] = 'Required'
      if (computed[i].qty === null || computed[i].qty === 0) e[`qty-${l.key}`] = 'Invalid'
      if (computed[i].price === null) e[`price-${l.key}`] = 'Invalid'
      if (l.accountId === '') e[`acct-${l.key}`] = 'Required'
    })
    if (lines.length === 0) e.lines = 'Add at least one line.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function save(issue: boolean) {
    if (!validate()) return
    if (issue) {
      const ok = await fb.confirm({
        title: 'Issue this invoice?',
        body: (
          <>
            It gets the next invoice number and is recorded in your books: <strong className="text-ink">{formatMoney(total)} owed to you</strong>, including{' '}
            {formatMoney(gst)} GST. Issued invoices can’t be edited, only voided.
          </>
        ),
        confirmLabel: 'Issue invoice'
      })
      if (!ok) return
    }
    setBusy(issue ? 'issue' : 'save')
    try {
      const draft = await mutate('invoices.saveDraft', {
        id: loaded?.id,
        clientId: clientId as number,
        issueDate,
        dueDate,
        notes,
        lines: lines.map((l, i) => ({
          description: l.description,
          qtyMilli: computed[i].qty!,
          unitPriceCents: computed[i].price!,
          taxable: l.taxable,
          accountId: l.accountId as number
        }))
      })
      if (issue) {
        const issued = await mutate('invoices.issue', { id: draft.id })
        fb.success(`Invoice ${issued.number} issued`)
        navigate(`/invoices/${issued.id}`)
      } else {
        fb.success('Draft saved')
        setLoaded(draft)
        if (id === undefined) navigate(`/invoices/${draft.id}/edit`)
      }
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!loaded) return
    const ok = await fb.confirm({ title: 'Delete this draft?', body: 'Drafts are not in your books, so nothing else changes.', confirmLabel: 'Delete draft', danger: true })
    if (!ok) return
    try {
      await mutate('invoices.deleteDraft', { id: loaded.id })
      fb.success('Draft deleted')
      navigate('/invoices')
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  if (loadError) return <Page><ErrorNote message={loadError} /></Page>
  if (!initialized || !clients.data) return <LoadingBlock />

  const activeClients = clients.data.filter((c) => !c.archived || c.id === clientId)
  const s = settings.data!

  return (
    <Page>
      <PageHeader
        back={<BackLink to="/invoices" label="Invoices" />}
        title={loaded ? 'Edit draft invoice' : 'New invoice'}
        subtitle={`Number assigned when issued (next: ${s.invoicePrefix}${s.nextInvoiceNumber})`}
        actions={
          <>
            {loaded ? <Button variant="ghost" icon={Trash2} onClick={remove}>Delete draft</Button> : null}
            <Button onClick={() => save(false)} loading={busy === 'save'} disabled={busy !== null}>
              Save draft
            </Button>
            <Button variant="primary" icon={Send} onClick={() => save(true)} loading={busy === 'issue'} disabled={busy !== null}>
              Issue invoice
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <Card>
            <div className="grid gap-4 sm:grid-cols-[1fr_170px_170px]">
              <Field label="Client" error={errors.client}>
                {(fid) => (
                  <div className="flex gap-2">
                    <Select id={fid} value={clientId} onChange={(e) => setClientId(e.target.value ? Number(e.target.value) : '')}>
                      <option value="">Choose a client…</option>
                      {activeClients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <Button icon={UserPlus} onClick={() => setClientModal(true)} aria-label="New client" title="New client" className="px-2.5" />
                  </div>
                )}
              </Field>
              <Field label="Invoice date">
                {(fid) => (
                  <Input
                    id={fid}
                    type="date"
                    value={issueDate}
                    onChange={(e) => {
                      const v = e.target.value
                      setIssueDate(v)
                      if (v) setDueDate(addDays(v, s.paymentTermsDays))
                    }}
                  />
                )}
              </Field>
              <Field label="Due date" error={errors.dueDate}>
                {(fid) => <Input id={fid} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
              </Field>
            </div>
          </Card>

          <Card title="Items" bodyClassName="">
            <div className="grid grid-cols-[1fr_76px_120px_110px_60px_32px] gap-x-3 border-b border-line px-5 py-2 text-xs font-medium text-muted">
              <span>Description</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Rate</span>
              <span className="text-right">Amount</span>
              <span className="text-center">GST</span>
              <span />
            </div>
            <div className="divide-y divide-line">
              {lines.map((l, i) => (
                <div key={l.key} className="px-5 py-3">
                  <div className="grid grid-cols-[1fr_76px_120px_110px_60px_32px] items-start gap-x-3">
                    <Input
                      value={l.description}
                      onChange={(e) => update(l.key, { description: e.target.value })}
                      placeholder="e.g. Consulting – October"
                      aria-label="Description"
                      className={cx(errors[`desc-${l.key}`] && 'border-danger')}
                    />
                    <Input
                      value={l.qty}
                      inputMode="decimal"
                      onChange={(e) => update(l.key, { qty: e.target.value })}
                      aria-label="Quantity"
                      className={cx('text-right tabular', errors[`qty-${l.key}`] && 'border-danger')}
                    />
                    <MoneyInput
                      value={l.price}
                      onChange={(e) => update(l.key, { price: e.target.value })}
                      placeholder="0.00"
                      aria-label="Rate"
                      className={cx(errors[`price-${l.key}`] && '[&_input]:border-danger')}
                    />
                    <div className="flex h-9 items-center justify-end text-sm font-medium tabular text-ink">
                      {computed[i].amount === null ? <span className="text-faint">—</span> : <Money cents={computed[i].amount!} />}
                    </div>
                    <label className="flex h-9 items-center justify-center" title="Charge GST on this line">
                      <input
                        type="checkbox"
                        checked={l.taxable}
                        onChange={(e) => update(l.key, { taxable: e.target.checked })}
                        className="size-4 accent-[var(--accent)]"
                        aria-label="Charge GST"
                      />
                    </label>
                    <IconButton
                      icon={X}
                      label="Remove line"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      disabled={lines.length === 1}
                      className="mt-0.5 disabled:opacity-30"
                    />
                  </div>
                  {incomeAccounts.length > 1 ? (
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                      <span>Income account</span>
                      <RevenueSelect accounts={incomeAccounts} value={l.accountId} onChange={(v) => update(l.key, { accountId: v })} invalid={!!errors[`acct-${l.key}`]} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="border-t border-line px-5 py-3">
              <Button size="sm" variant="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, blankLine(salesId)])}>
                Add line
              </Button>
            </div>
          </Card>

          <Card>
            <Field label="Notes" hint="Shown on the invoice, e.g. payment instructions (e-Transfer to billing@…).">
              {(fid) => <Textarea id={fid} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
          </Card>
        </div>

        <div>
          <Card className="sticky top-6" title="Summary">
            <dl className="space-y-2.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Subtotal</dt>
                <dd className="tabular">
                  <Money cents={subtotal} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">GST 5%{taxable !== subtotal ? <span className="text-faint"> on {formatMoney(taxable)}</span> : null}</dt>
                <dd className="tabular">
                  <Money cents={gst} />
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-3 text-base font-semibold">
                <dt>Total</dt>
                <dd>
                  <Money cents={total} />
                </dd>
              </div>
            </dl>
            {!s.gstNumber ? (
              <p className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                Add your GST number in Settings. Clients need it on the invoice to claim the GST back.
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      <ClientModal open={clientModal} onClose={() => setClientModal(false)} onSaved={(c) => setClientId(c.id)} />
    </Page>
  )
}

function RevenueSelect({ accounts, value, onChange, invalid }: { accounts: Account[]; value: number | ''; onChange: (v: number | '') => void; invalid: boolean }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
      className={cx('h-7 rounded-md border bg-surface px-2 text-xs text-ink', invalid ? 'border-danger' : 'border-line')}
    >
      <option value="">Choose…</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.code} · {a.name}
        </option>
      ))}
    </select>
  )
}
