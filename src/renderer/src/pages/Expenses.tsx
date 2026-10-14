import { useEffect, useState } from 'react'
import { Plus, Receipt, Search } from 'lucide-react'
import { todayIso } from '../../../shared/dates'
import { gstIncluded } from '../../../shared/money'
import type { Expense } from '../../../shared/types'
import { AccountSelect } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, Checkbox, EmptyState, ErrorNote, Field, Input, LoadingBlock, Modal, Money, MoneyInput, Page, PageHeader, td, tdNum, th, thNum, tr } from '../components/ui'
import { mutate, useQuery } from '../lib/api'
import { centsToPlain, formatDate, formatMoney, parseMoney } from '../lib/format'
import { navigate, queryParam, usePath } from '../lib/router'

export default function Expenses() {
  const path = usePath()
  const fb = useFeedback()
  const { data, error } = useQuery('expenses.list')
  const [open, setOpen] = useState(queryParam(path, 'new') === '1')
  const [q, setQ] = useState('')

  const needle = q.trim().toLowerCase()
  const shown = (data ?? []).filter((x) => !needle || x.vendor.toLowerCase().includes(needle) || x.accountName.toLowerCase().includes(needle) || x.description.toLowerCase().includes(needle))
  const year = todayIso().slice(0, 4)
  const thisYear = (data ?? []).filter((x) => !x.voided && x.date.startsWith(year))

  async function voidExpense(x: Expense) {
    const ok = await fb.confirm({
      title: `Void “${x.vendor}”?`,
      body: 'A reversing entry is recorded today. The original stays in the journal for your records.',
      confirmLabel: 'Void expense',
      danger: true
    })
    if (!ok) return
    try {
      await mutate('expenses.void', { id: x.id, date: todayIso() })
      fb.success('Expense voided')
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Expenses"
        subtitle={data ? `${formatMoney(thisYear.reduce((s, x) => s + x.amountCents, 0))} before GST in ${year} · ${formatMoney(thisYear.reduce((s, x) => s + x.gstCents, 0))} GST to claim back` : undefined}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            Add expense
          </Button>
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            icon={Receipt}
            title="No expenses yet"
            body="Record receipts and bills here, or import them from your bank statement. The GST you paid is claimed back on your GST return."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
                Add expense
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex justify-end">
            <div className="relative w-64">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-faint" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor or category" className="pl-9" />
            </div>
          </div>
          <Card bodyClassName="">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>Vendor</th>
                  <th className={th}>Category</th>
                  <th className={th}>Paid from</th>
                  <th className={thNum}>GST</th>
                  <th className={thNum}>Total</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.id} className={tr}>
                    <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(x.date)}</td>
                    <td className={td}>
                      <div className={x.voided ? 'text-faint line-through' : 'font-medium'}>{x.vendor}</div>
                      {x.description ? <div className="text-xs text-muted">{x.description}</div> : null}
                    </td>
                    <td className={`${td} text-muted`}>{x.accountName}</td>
                    <td className={`${td} text-muted`}>{x.paidFromName}</td>
                    <td className={`${tdNum} text-muted`}>
                      <Money cents={x.gstCents} />
                    </td>
                    <td className={`${tdNum} font-medium`}>
                      <Money cents={x.totalCents} className={x.voided ? 'text-faint line-through' : ''} />
                    </td>
                    <td className={`${td} w-16 text-right`}>
                      {x.voided ? (
                        <Badge>Void</Badge>
                      ) : (
                        <button className="text-xs text-muted hover:text-danger" onClick={() => voidExpense(x)}>
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <ExpenseModal
        open={open}
        onClose={() => {
          setOpen(false)
          if (queryParam(path, 'new')) navigate('/expenses')
        }}
      />
    </Page>
  )
}

function ExpenseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const [date, setDate] = useState(todayIso())
  const [vendor, setVendor] = useState('')
  const [description, setDescription] = useState('')
  const [accountId, setAccountId] = useState<number | ''>('')
  const [total, setTotal] = useState('')
  const [gst, setGst] = useState('')
  const [gstEdited, setGstEdited] = useState(false)
  const [noGst, setNoGst] = useState(false)
  const [paidFrom, setPaidFrom] = useState<number | ''>('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [another, setAnother] = useState(false)

  const list = accounts.data ?? []
  const bankId = list.find((a) => a.role === 'bank')?.id ?? ''

  useEffect(() => {
    if (!open) return
    setVendor('')
    setDescription('')
    setTotal('')
    setGst('')
    setGstEdited(false)
    setNoGst(false)
    setErrors({})
  }, [open])

  const totalCents = parseMoney(total)
  const autoGst = totalCents !== null && totalCents > 0 ? gstIncluded(totalCents) : 0
  const gstCents = noGst ? 0 : gstEdited ? parseMoney(gst) : autoGst
  const preTax = totalCents !== null && gstCents !== null ? totalCents - gstCents : null

  async function save() {
    const e: Record<string, string> = {}
    if (!vendor.trim()) e.vendor = 'Who did you pay?'
    if (accountId === '') e.account = 'Choose a category.'
    if (totalCents === null || totalCents <= 0) e.total = 'Enter the total you paid.'
    if (gstCents === null || gstCents < 0) e.gst = 'Enter the GST shown on the receipt.'
    else if (preTax !== null && preTax <= 0) e.gst = 'GST must be less than the total.'
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    try {
      await mutate('expenses.create', {
        date,
        vendor,
        description,
        accountId: accountId as number,
        amountCents: preTax!,
        gstCents: gstCents!,
        paidFromAccountId: (paidFrom === '' ? bankId : paidFrom) as number
      })
      fb.success(`Expense recorded: ${vendor}`)
      if (another) {
        setVendor('')
        setDescription('')
        setTotal('')
        setGst('')
        setGstEdited(false)
      } else onClose()
    } catch (err) {
      fb.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add expense"
      description="Enter a receipt or bill the company paid."
      footer={
        <div className="flex w-full items-center justify-between">
          <Checkbox label="Add another after this" checked={another} onChange={(e) => setAnother(e.target.checked)} />
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={saving}>
              Save expense
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-[1fr_170px] gap-4">
          <Field label="Vendor" error={errors.vendor}>
            {(id) => <Input id={id} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Staples, Telus, Air Canada" autoFocus />}
          </Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="Category" error={errors.account}>
          {(id) => (
            <AccountSelect
              id={id}
              accounts={list}
              allow={(a) => (a.type === 'expense' || a.type === 'asset') && !a.isBank && a.role === null}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}
              placeholder="Choose a category…"
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Total paid (including GST)" error={errors.total}>
            {(id) => <MoneyInput id={id} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0.00" />}
          </Field>
          <Field
            label="GST on the receipt"
            error={errors.gst}
            hint={noGst ? 'No GST (e.g. insurance, bank fees, exempt items).' : gstEdited ? 'As entered from the receipt.' : 'Calculated as 5/105 of the total. Change it to match the receipt.'}
          >
            {(id) => (
              <MoneyInput
                id={id}
                value={noGst ? '0.00' : gstEdited ? gst : centsToPlain(autoGst)}
                disabled={noGst}
                onChange={(e) => {
                  setGstEdited(true)
                  setGst(e.target.value)
                }}
              />
            )}
          </Field>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-subtle px-4 py-2.5 text-sm">
          <Checkbox label="No GST on this purchase" checked={noGst} onChange={(e) => setNoGst(e.target.checked)} />
          <span className="text-muted">
            Expense before GST: <span className="font-medium text-ink tabular">{preTax !== null && preTax > 0 ? formatMoney(preTax) : '—'}</span>
          </span>
        </div>
        <Field label="Paid from" hint="Paid with your own money? Choose the shareholder loan: the company then owes you back.">
          {(id) => (
            <AccountSelect
              id={id}
              accounts={list}
              allow={(a) => a.isBank || a.role === 'shareholder_loan'}
              value={paidFrom === '' ? bankId : paidFrom}
              onChange={(e) => setPaidFrom(e.target.value ? Number(e.target.value) : '')}
            />
          )}
        </Field>
        <Field label="Note (optional)">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
    </Modal>
  )
}
