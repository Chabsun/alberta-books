import { useEffect, useState } from 'react'
import { Ban, Download, HandCoins, Pencil } from 'lucide-react'
import { todayIso } from '../../../shared/dates'
import { BackLink, InvoiceStatusBadge, AccountSelect } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, ErrorNote, Field, Input, LoadingBlock, Modal, Money, MoneyInput, Page, PageHeader, td, tdNum, th, thNum, tr } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { centsToPlain, formatDate, formatMoney, formatQuantity, parseMoney } from '../lib/format'
import { navigate } from '../lib/router'

export default function InvoiceDetail({ id }: { id: number }) {
  const fb = useFeedback()
  const { data: inv, error } = useQuery('invoices.get', { id })
  const settings = useQuery('settings.get')
  const clients = useQuery('clients.list', { includeArchived: true })
  const [payOpen, setPayOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)

  if (error) return <Page><ErrorNote message={error} /></Page>
  if (!inv || !settings.data) return <LoadingBlock />
  const client = clients.data?.find((c) => c.id === inv.clientId)
  const s = settings.data

  async function pdf() {
    setPdfBusy(true)
    try {
      const r = await call('invoices.exportPdf', { id })
      if (r.savedTo) fb.success('PDF saved')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setPdfBusy(false)
    }
  }

  async function voidPayment(paymentId: number) {
    const ok = await fb.confirm({
      title: 'Void this payment?',
      body: 'A reversing entry is recorded today and the invoice becomes unpaid again. Use this if the payment was entered by mistake or bounced.',
      confirmLabel: 'Void payment',
      danger: true
    })
    if (!ok) return
    try {
      await mutate('invoices.voidPayment', { paymentId, date: todayIso() })
      fb.success('Payment voided')
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        back={<BackLink to="/invoices" label="Invoices" />}
        title={
          <span className="flex items-center gap-3">
            {inv.number ?? 'Draft invoice'} <InvoiceStatusBadge status={inv.displayStatus} />
          </span>
        }
        subtitle={`${inv.clientName} · ${formatMoney(inv.totalCents)}`}
        actions={
          <>
            {inv.status === 'draft' ? (
              <Button icon={Pencil} onClick={() => navigate(`/invoices/${id}/edit`)}>
                Edit
              </Button>
            ) : null}
            {inv.status === 'issued' && inv.payments.every((p) => p.voided) ? (
              <Button variant="ghost" icon={Ban} onClick={() => setVoidOpen(true)}>
                Void
              </Button>
            ) : null}
            <Button icon={Download} onClick={pdf} loading={pdfBusy}>
              Download PDF
            </Button>
            {inv.status === 'issued' && inv.balanceCents > 0 ? (
              <Button variant="primary" icon={HandCoins} onClick={() => setPayOpen(true)}>
                Record payment
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Paper-style preview of the invoice */}
        <div className="rounded-xl border border-line bg-white p-10 text-zinc-900 shadow-sm dark:border-line">
          <div className="flex items-start justify-between gap-6">
            <div>
              <div className="text-lg font-bold tracking-tight">{s.companyName}</div>
              <div className="mt-1 text-xs leading-relaxed whitespace-pre-line text-zinc-500">{s.address}</div>
              {s.gstNumber ? <div className="mt-1 text-xs text-zinc-500">GST registration: {s.gstNumber}</div> : null}
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold tracking-wider text-teal-700">INVOICE</div>
              <div className="mt-2 space-y-0.5 text-xs text-zinc-600">
                <div>
                  <span className="text-zinc-400">Invoice</span> <strong className="text-zinc-900">{inv.number ?? 'DRAFT'}</strong>
                </div>
                <div>
                  <span className="text-zinc-400">Date</span> {formatDate(inv.issueDate)}
                </div>
                <div>
                  <span className="text-zinc-400">Due</span> {formatDate(inv.dueDate)}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-8">
            <div className="text-[10px] font-medium tracking-widest text-zinc-400 uppercase">Bill to</div>
            <div className="mt-1 text-sm font-semibold">{inv.clientName}</div>
            {client?.address ? <div className="text-xs whitespace-pre-line text-zinc-500">{client.address}</div> : null}
          </div>
          <table className="mt-8 w-full text-sm">
            <thead>
              <tr className="border-b-2 border-zinc-900 text-[10px] tracking-widest text-zinc-500 uppercase">
                <th className="py-2 text-left font-medium">Description</th>
                <th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 text-right font-medium">Rate</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id} className="border-b border-zinc-200">
                  <td className="py-2.5 pr-4">
                    {l.description}
                    {!l.taxable ? <span className="ml-1 text-xs text-zinc-400">(GST exempt)</span> : null}
                  </td>
                  <td className="py-2.5 text-right tabular">{formatQuantity(l.qtyMilli)}</td>
                  <td className="py-2.5 text-right tabular">{formatMoney(l.unitPriceCents)}</td>
                  <td className="py-2.5 text-right tabular">{formatMoney(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 ml-auto w-64 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Subtotal</span>
              <span className="tabular">{formatMoney(inv.subtotalCents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">GST (5%)</span>
              <span className="tabular">{formatMoney(inv.gstCents)}</span>
            </div>
            <div className="flex justify-between border-t-2 border-zinc-900 pt-2 font-bold">
              <span>Total (CAD)</span>
              <span className="tabular">{formatMoney(inv.totalCents)}</span>
            </div>
          </div>
          {inv.notes ? <div className="mt-8 text-xs leading-relaxed whitespace-pre-line text-zinc-600">{inv.notes}</div> : null}
        </div>

        <div className="space-y-6">
          <Card title="Payment">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Total</dt>
                <dd><Money cents={inv.totalCents} /></dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Paid</dt>
                <dd><Money cents={inv.paidCents} /></dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold">
                <dt>Balance due</dt>
                <dd><Money cents={inv.balanceCents} /></dd>
              </div>
            </dl>
          </Card>

          {inv.payments.length > 0 ? (
            <Card title="Payments received" bodyClassName="">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Date</th>
                    <th className={thNum}>Amount</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {inv.payments.map((p) => (
                    <tr key={p.id} className={tr}>
                      <td className={td}>
                        <div>{formatDate(p.date)}</div>
                        <div className="text-xs text-muted">{p.accountName}</div>
                      </td>
                      <td className={tdNum}>
                        <Money cents={p.amountCents} className={p.voided ? 'text-faint line-through' : ''} />
                      </td>
                      <td className={`${td} text-right`}>
                        {p.voided ? (
                          <Badge>Void</Badge>
                        ) : inv.status === 'issued' ? (
                          <button className="text-xs text-muted hover:text-danger" onClick={() => voidPayment(p.id)}>
                            Void
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          {inv.status === 'void' ? (
            <Card bodyClassName="px-5 py-4 text-sm text-muted">This invoice was voided. A reversing entry removed it from your books; the original stays in the journal for your records.</Card>
          ) : null}
        </div>
      </div>

      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} invoiceId={id} balance={inv.balanceCents} />
      <VoidModal open={voidOpen} onClose={() => setVoidOpen(false)} invoiceId={id} number={inv.number ?? ''} />
    </Page>
  )
}

function PaymentModal({ open, onClose, invoiceId, balance }: { open: boolean; onClose: () => void; invoiceId: number; balance: number }) {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const [date, setDate] = useState(todayIso())
  const [amount, setAmount] = useState(centsToPlain(balance))
  const [accountId, setAccountId] = useState<number | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setDate(todayIso())
    setAmount(centsToPlain(balance))
    setError(null)
  }, [open, balance])

  const bankId = accounts.data?.find((a) => a.role === 'bank')?.id ?? ''
  const chosen = accountId === '' ? bankId : accountId

  async function save() {
    const cents = parseMoney(amount)
    if (cents === null || cents <= 0) return setError('Enter the amount received.')
    if (cents > balance) return setError(`That is more than the ${formatMoney(balance)} owing.`)
    if (chosen === '') return setError('Choose the account the money went into.')
    setSaving(true)
    try {
      await mutate('invoices.recordPayment', { invoiceId, date, amountCents: cents, accountId: chosen })
      fb.success('Payment recorded')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record payment"
      description="Money received from the client for this invoice."
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Date received">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Amount" error={error}>
            {(id) => <MoneyInput id={id} value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
        </div>
        <Field label="Deposited to">
          {(id) => (
            <AccountSelect
              id={id}
              accounts={accounts.data ?? []}
              allow={(a) => a.isBank && a.type === 'asset'}
              value={chosen}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}
            />
          )}
        </Field>
      </div>
    </Modal>
  )
}

function VoidModal({ open, onClose, invoiceId, number }: { open: boolean; onClose: () => void; invoiceId: number; number: string }) {
  const fb = useFeedback()
  const [date, setDate] = useState(todayIso())
  const [saving, setSaving] = useState(false)
  async function confirm() {
    setSaving(true)
    try {
      await mutate('invoices.void', { id: invoiceId, date })
      fb.success(`Invoice ${number} voided`)
      onClose()
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Void invoice ${number}?`}
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={confirm} loading={saving}>
            Void invoice
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-muted">
        A reversing entry removes the sale and its GST from your books on the date below. The invoice number stays used, so your numbering keeps no gaps.
      </p>
      <Field label="Void date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
    </Modal>
  )
}
