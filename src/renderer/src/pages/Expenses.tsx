import { useEffect, useState } from 'react'
import { AlertTriangle, Plus, Receipt, Search } from 'lucide-react'
import { todayIso } from '../../../shared/dates'
import { gstIncluded } from '../../../shared/money'
import { taxRule } from '../../../shared/taxRules'
import type { Expense, ExpensePreview } from '../../../shared/types'
import { readFile, ReceiptCount, Receipts, RECEIPT_ACCEPT, RuleHint, FileDrop, useDebounced } from '../components/books'
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
  Input,
  LoadingBlock,
  Modal,
  Money,
  MoneyInput,
  Page,
  PageHeader,
  Select,
  td,
  tdNum,
  th,
  thNum,
  trClickable
} from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { centsToPlain, formatDate, formatMoney, parseMoney } from '../lib/format'
import { navigate, queryParam, usePath } from '../lib/router'

export default function Expenses() {
  const path = usePath()
  const { data, error } = useQuery('expenses.list')
  const [open, setOpen] = useState(queryParam(path, 'new') === '1')
  const [detail, setDetail] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)

  const needle = q.trim().toLowerCase()
  const shown = (data ?? []).filter(
    (x) =>
      (!needle || `${x.vendor} ${x.accountName} ${x.description}`.toLowerCase().includes(needle)) &&
      (!onlyMissing || (!x.voided && x.warnings.length > 0))
  )
  const year = todayIso().slice(0, 4)
  const thisYear = (data ?? []).filter((x) => !x.voided && x.date.startsWith(year))
  const missing = (data ?? []).filter((x) => !x.voided && x.warnings.length > 0).length

  return (
    <Page>
      <PageHeader
        title="Expenses"
        subtitle={
          data
            ? `${formatMoney(thisYear.reduce((s, x) => s + x.amountCents, 0))} before GST in ${year} · ${formatMoney(thisYear.reduce((s, x) => s + x.itcCents, 0))} GST claimed back`
            : undefined
        }
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
            body="Record receipts here, or categorize them from the bank feed. CRA rules (meals 50%, equipment as capital assets, vehicle limits) are applied for you."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
                Add expense
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              {missing ? (
                <Checkbox
                  label={
                    <span>
                      Only show expenses missing what CRA asks for <Badge tone="warn">{missing}</Badge>
                    </span>
                  }
                  checked={onlyMissing}
                  onChange={(e) => setOnlyMissing(e.target.checked)}
                />
              ) : null}
            </div>
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
                  <th className={thNum}>GST back</th>
                  <th className={thNum}>Total</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.id} className={trClickable} onClick={() => setDetail(x.id)}>
                    <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(x.date)}</td>
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <span className={x.voided ? 'text-faint line-through' : 'font-medium'}>{x.vendor}</span>
                        <ReceiptCount n={x.receiptCount} />
                      </div>
                      {x.description ? <div className="text-xs text-muted">{x.description}</div> : null}
                    </td>
                    <td className={`${td} text-muted`}>
                      {x.accountName}
                      {x.businessPct < 100 ? <span className="ml-1.5 text-xs text-faint">{x.businessPct}% business</span> : null}
                    </td>
                    <td className={`${tdNum} text-muted`}>
                      <Money cents={x.itcCents} />
                    </td>
                    <td className={`${tdNum} font-medium`}>
                      <Money cents={x.totalCents} className={x.voided ? 'text-faint line-through' : ''} />
                    </td>
                    <td className={`${td} w-24 text-right`}>
                      {x.voided ? (
                        <Badge>Void</Badge>
                      ) : x.warnings.length ? (
                        <span title={x.warnings.join('\n')}>
                          <Badge tone="warn">
                            <AlertTriangle className="size-3" />
                            {x.warnings.length}
                          </Badge>
                        </span>
                      ) : null}
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
      {detail !== null ? <ExpenseDetail expense={(data ?? []).find((x) => x.id === detail)} onClose={() => setDetail(null)} /> : null}
    </Page>
  )
}

// ---------------------------------------------------------------- new expense

function ExpenseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const vehicles = useQuery('vehicles.list')
  const [date, setDate] = useState(todayIso())
  const [vendor, setVendor] = useState('')
  const [description, setDescription] = useState('')
  const [accountId, setAccountId] = useState<number | ''>('')
  const [total, setTotal] = useState('')
  const [gst, setGst] = useState('')
  const [gstEdited, setGstEdited] = useState(false)
  const [noGst, setNoGst] = useState(false)
  const [paidFrom, setPaidFrom] = useState<number | ''>('')
  const [businessPct, setBusinessPct] = useState('100')
  const [gstNumber, setGstNumber] = useState('')
  const [purpose, setPurpose] = useState('')
  const [attendees, setAttendees] = useState('')
  const [vehicleId, setVehicleId] = useState<number | ''>('')
  const [primarilyBusiness, setPrimarilyBusiness] = useState(true)
  const [files, setFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [another, setAnother] = useState(false)
  const [preview, setPreview] = useState<ExpensePreview | null>(null)

  const list = accounts.data ?? []
  const bankId = list.find((a) => a.role === 'bank')?.id ?? ''
  const account = list.find((a) => a.id === accountId)
  const rule = taxRule(account?.taxRule)
  const isVehicle = !!rule.vehicle || rule.id === 'capital_vehicle'
  const allowsBusinessPct = !rule.ccaClass && !rule.vehicle

  const reset = () => {
    setVendor('')
    setDescription('')
    setTotal('')
    setGst('')
    setGstEdited(false)
    setNoGst(false)
    setBusinessPct('100')
    setGstNumber('')
    setPurpose('')
    setAttendees('')
    setFiles([])
    setErrors({})
  }
  useEffect(() => {
    if (open) reset()
  }, [open])
  useEffect(() => {
    // Most categories with no GST (bank fees, insurance) are known from the rule.
    if (account) setNoGst(rule.gst !== 'taxable')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  const totalCents = parseMoney(total)
  const autoGst = totalCents !== null && totalCents > 0 ? gstIncluded(totalCents) : 0
  const gstCents = noGst ? 0 : gstEdited ? parseMoney(gst) : autoGst
  const preTax = totalCents !== null && gstCents !== null ? totalCents - gstCents : null
  const pct = Number(businessPct)
  const pctValid = Number.isInteger(pct) && pct >= 0 && pct <= 100

  const input =
    accountId !== '' && preTax !== null && preTax > 0 && gstCents !== null && pctValid
      ? {
          date,
          vendor: vendor.trim() || 'Vendor',
          description,
          accountId: accountId as number,
          amountCents: preTax,
          gstCents,
          paidFromAccountId: (paidFrom === '' ? bankId : paidFrom) as number,
          businessPct: allowsBusinessPct ? pct : undefined,
          supplierGstNumber: gstNumber.trim() || undefined,
          purpose: purpose.trim() || undefined,
          attendees: attendees.trim() || undefined,
          vehicleId: isVehicle && vehicleId !== '' ? vehicleId : null,
          primarilyBusiness: rule.id === 'capital_vehicle' ? primarilyBusiness : undefined
        }
      : null
  const debounced = useDebounced(input ? JSON.stringify(input) : '')
  useEffect(() => {
    if (!debounced || !open) return setPreview(null)
    let alive = true
    call('expenses.preview', JSON.parse(debounced))
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null))
    return () => {
      alive = false
    }
  }, [debounced, open])

  async function save() {
    const e: Record<string, string> = {}
    if (!vendor.trim()) e.vendor = 'Who did you pay?'
    if (accountId === '') e.account = 'Choose a category.'
    if (totalCents === null || totalCents <= 0) e.total = 'Enter the total you paid.'
    if (gstCents === null || gstCents < 0) e.gst = 'Enter the GST shown on the receipt.'
    else if (preTax !== null && preTax <= 0) e.gst = 'GST must be less than the total.'
    if (!pctValid) e.pct = 'Enter a whole number from 0 to 100.'
    if (gstNumber.trim() && !/^\d{9}\s?RT\s?\d{4}$/i.test(gstNumber.trim())) e.gstNumber = 'Looks like 123456789 RT0001.'
    setErrors(e)
    if (Object.keys(e).length || !input) return
    setSaving(true)
    try {
      const x = await mutate('expenses.create', { ...input, vendor: vendor.trim() })
      for (const f of files) {
        const { fileName, bytes } = await readFile(f)
        await mutate('receipts.upload', { fileName, bytes, expenseId: x.id })
      }
      fb.success(x.warnings.length ? `Saved. Still needed: ${x.warnings.join(' ')}` : `Expense recorded: ${x.vendor}`)
      if (another) reset()
      else onClose()
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
      width="lg"
      title="Add expense"
      description="Enter a receipt or bill the company paid. Already in your bank statement? Categorize it from the Bank feed instead."
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
              allow={(a) => (a.type === 'expense' || a.type === 'asset') && !a.isBank && a.role === null && (a.type === 'expense' || !!a.taxRule)}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}
              placeholder="Choose a category…"
            />
          )}
        </Field>
        {account ? <RuleHint ruleId={account.taxRule} /> : null}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Total paid (including GST)" error={errors.total}>
            {(id) => <MoneyInput id={id} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0.00" />}
          </Field>
          <Field
            label="GST on the receipt"
            error={errors.gst}
            hint={noGst ? 'No GST on this purchase.' : gstEdited ? 'As entered from the receipt.' : 'Calculated as 5/105 of the total. Change it to match the receipt.'}
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
            Before GST: <span className="font-medium text-ink tabular">{preTax !== null && preTax > 0 ? formatMoney(preTax) : '—'}</span>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Paid from" hint="Paid personally? Choose the shareholder loan: the company owes you back.">
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
          {allowsBusinessPct ? (
            <Field label="Business use %" error={errors.pct} hint="Partly personal (e.g. phone)? The personal share is charged to your shareholder loan.">
              {(id) => <Input id={id} inputMode="numeric" value={businessPct} onChange={(e) => setBusinessPct(e.target.value)} className="w-28" />}
            </Field>
          ) : isVehicle ? (
            <Field label="Vehicle" hint="Business use comes from the vehicle’s logbook.">
              {(id) => (
                <Select id={id} value={vehicleId} onChange={(e) => setVehicleId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Choose…</option>
                  {(vehicles.data ?? []).filter((v) => !v.archived).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        {rule.id === 'capital_vehicle' ? (
          <Checkbox label="Used more than 50% for business (needed to claim the GST)" checked={primarilyBusiness} onChange={(e) => setPrimarilyBusiness(e.target.checked)} />
        ) : null}

        {rule.needsPurpose || rule.needsAttendees ? (
          <div className="grid grid-cols-2 gap-4">
            {rule.needsPurpose ? (
              <Field label="Business purpose" hint="CRA asks for this.">
                {(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Project kickoff with Acme" />}
              </Field>
            ) : null}
            {rule.needsAttendees ? (
              <Field label="Who attended" hint="Names and companies.">
                {(id) => <Input id={id} value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="e.g. J. Smith (Acme Energy)" />}
              </Field>
            ) : null}
          </div>
        ) : null}
        {totalCents !== null && totalCents >= 100_00 && (gstCents ?? 0) > 0 ? (
          <Field label="Supplier’s GST number" error={errors.gstNumber} hint="Required on receipts of $100 or more to claim the GST back.">
            {(id) => <Input id={id} value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} placeholder="123456789 RT0001" className="w-64" />}
          </Field>
        ) : null}

        {preview ? <Treatment p={preview} /> : null}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Note (optional)">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-ink">Receipt</div>
            {files.length ? (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                <span className="truncate">{files.map((f) => f.name).join(', ')}</span>
                <button className="text-xs text-muted hover:text-ink" onClick={() => setFiles([])}>
                  Remove
                </button>
              </div>
            ) : (
              <FileDrop compact multiple accept={RECEIPT_ACCEPT} label="Choose or drop" hint="PDF or photo" onFiles={setFiles} />
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function Treatment({ p }: { p: ExpensePreview }) {
  return (
    <div className="rounded-lg border border-line px-4 py-3 text-[13px]">
      <div className="grid grid-cols-4 gap-3">
        <Stat label={p.asset ? `Capital cost (CCA class ${p.asset.ccaClass})` : 'Expense'} cents={p.asset ? p.asset.capitalCostCents : p.costCents} />
        <Stat label="GST claimed back" cents={p.itcCents} />
        <Stat label="Not deductible" cents={p.nonDeductibleCents} />
        <Stat label="Personal (shareholder loan)" cents={p.personalCents} />
      </div>
      {p.notes.length ? <ul className="mt-2.5 list-disc space-y-0.5 pl-5 text-muted">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      <div className="mt-2.5 text-muted">
        <span className="font-medium text-ink">The receipt must show: </span>
        {p.receiptMustShow.join(' · ')}
      </div>
    </div>
  )
}

function Stat({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 font-medium tabular text-ink">{formatMoney(cents)}</div>
    </div>
  )
}

// ---------------------------------------------------------------- one expense

function ExpenseDetail({ expense: x, onClose }: { expense: Expense | undefined; onClose: () => void }) {
  const fb = useFeedback()
  const [gstNumber, setGstNumber] = useState(x?.supplierGstNumber ?? '')
  const [purpose, setPurpose] = useState(x?.purpose ?? '')
  const [attendees, setAttendees] = useState(x?.attendees ?? '')
  const [description, setDescription] = useState(x?.description ?? '')
  const [saving, setSaving] = useState(false)
  if (!x) return null
  const rule = taxRule(x.taxRule)
  const changed = gstNumber !== x.supplierGstNumber || purpose !== x.purpose || attendees !== x.attendees || description !== x.description

  async function save() {
    setSaving(true)
    try {
      await mutate('expenses.updateDetails', { id: x!.id, supplierGstNumber: gstNumber, purpose, attendees, description })
      fb.success('Details saved')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function voidIt() {
    const ok = await fb.confirm({
      title: `Void “${x!.vendor}”?`,
      body: 'A reversing entry is recorded today. The original stays in the journal for your records.',
      confirmLabel: 'Void expense',
      danger: true
    })
    if (!ok) return
    try {
      await mutate('expenses.void', { id: x!.id, date: todayIso() })
      fb.success('Expense voided')
      onClose()
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={x.vendor}
      description={`${formatDate(x.date)} · ${x.accountName} · paid from ${x.paidFromName}`}
      footer={
        <div className="flex w-full justify-between">
          {x.voided ? <Badge>Void</Badge> : <Button variant="danger" onClick={voidIt}>Void expense</Button>}
          <div className="flex gap-2">
            <Button onClick={onClose}>Close</Button>
            {!x.voided ? (
              <Button variant="primary" onClick={save} loading={saving} disabled={!changed}>
                Save details
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-4 gap-3 rounded-lg border border-line px-4 py-3 text-[13px]">
          <Stat label="Before GST" cents={x.amountCents} />
          <Stat label="GST paid" cents={x.gstCents} />
          <Stat label="GST claimed back" cents={x.itcCents} />
          <Stat label="Not deductible" cents={x.nonDeductibleCents} />
        </div>
        {x.warnings.length && !x.voided ? (
          <div className="rounded-lg bg-warn-soft px-4 py-3 text-sm ring-1 ring-warn/25 ring-inset">
            <div className="mb-1 font-medium text-ink">What CRA would still ask for</div>
            <ul className="list-disc space-y-0.5 pl-5 text-ink/80">{x.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        ) : null}
        <RuleHint ruleId={x.taxRule} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Supplier’s GST number">{(id) => <Input id={id} value={gstNumber} disabled={x.voided} onChange={(e) => setGstNumber(e.target.value)} placeholder="123456789 RT0001" />}</Field>
          <Field label="Note">{(id) => <Input id={id} value={description} disabled={x.voided} onChange={(e) => setDescription(e.target.value)} />}</Field>
          {rule.needsPurpose || x.purpose ? (
            <Field label="Business purpose">{(id) => <Input id={id} value={purpose} disabled={x.voided} onChange={(e) => setPurpose(e.target.value)} />}</Field>
          ) : null}
          {rule.needsAttendees || x.attendees ? (
            <Field label="Who attended">{(id) => <Input id={id} value={attendees} disabled={x.voided} onChange={(e) => setAttendees(e.target.value)} />}</Field>
          ) : null}
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink">Receipts</div>
          <Receipts expenseId={x.id} />
        </div>
      </div>
    </Modal>
  )
}
