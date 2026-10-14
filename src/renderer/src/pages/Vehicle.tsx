import { useEffect, useState } from 'react'
import { Car, Plus, Trash2 } from 'lucide-react'
import { fiscalYearOf, todayIso } from '../../../shared/dates'
import type { Vehicle as VehicleT, VehicleBenefit } from '../../../shared/types'
import { useFeedback } from '../components/feedback'
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  MoneyInput,
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
import { mutate, useQuery } from '../lib/api'
import { centsToPlain, formatDate, formatMoney, parseMoney } from '../lib/format'

export default function Vehicle() {
  const vehicles = useQuery('vehicles.list')
  const settings = useQuery('settings.get')
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<VehicleT | 'new' | null>(null)
  const active = (vehicles.data ?? []).filter((v) => !v.archived)
  const vehicle = active.find((v) => v.id === selected) ?? active[0]

  return (
    <Page>
      <PageHeader
        title="Company vehicle"
        subtitle="Logbook, your taxable benefit for personal use, and the CRA limits on lease and interest."
        actions={
          <>
            {vehicle ? <Button onClick={() => setEditing(vehicle)}>Edit vehicle</Button> : null}
            <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
              Add vehicle
            </Button>
          </>
        }
      />
      {!vehicles.data || !settings.data ? (
        <LoadingBlock />
      ) : !vehicle ? (
        <Card>
          <EmptyState
            icon={Car}
            title="No company vehicle"
            body="If the corporation owns or leases your vehicle, add it here. You then keep a logbook, and the app works out the standby charge, operating benefit and the GST the company remits on them."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
                Add vehicle
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {active.length > 1 ? (
            <Segmented value={String(vehicle.id)} onChange={(v) => setSelected(Number(v))} options={active.map((v) => ({ value: String(v.id), label: v.name }))} />
          ) : null}
          <BenefitCard vehicle={vehicle} />
          <LimitsCard vehicle={vehicle} fiscalYearEndMonth={settings.data.fiscalYearEndMonth} />
          <Logbook vehicle={vehicle} />
        </div>
      )}
      {editing ? <VehicleModal vehicle={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Page>
  )
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1.5 text-sm ${strong ? 'border-t border-line pt-2.5 font-semibold' : ''}`}>
      <span className={strong ? 'text-ink' : 'text-muted'}>{label}</span>
      <span className="tabular text-ink">{value}</span>
    </div>
  )
}

function BenefitCard({ vehicle }: { vehicle: VehicleT }) {
  const fb = useFeedback()
  const thisYear = Number(todayIso().slice(0, 4))
  const [year, setYear] = useState(todayIso().slice(5) <= '02-28' ? thisYear - 1 : thisYear)
  const { data: b } = useQuery('vehicles.benefit', { vehicleId: vehicle.id, year })
  const [opReimb, setOpReimb] = useState('')
  const [sbReimb, setSbReimb] = useState('')
  const [half, setHalf] = useState(false)
  useEffect(() => {
    if (!b) return
    setOpReimb(centsToPlain(b.reimbursedOperatingCents))
    setSbReimb(centsToPlain(b.reimbursedStandbyCents))
    setHalf(b.electHalfStandby)
  }, [b?.vehicleId, b?.year, b?.reimbursedOperatingCents, b?.reimbursedStandbyCents, b?.electHalfStandby])

  async function save(patch: Partial<{ op: string; sb: string; half: boolean }> = {}) {
    const op = parseMoney(patch.op ?? opReimb)
    const sb = parseMoney(patch.sb ?? sbReimb)
    if (op === null || sb === null || op < 0 || sb < 0) return fb.error('Enter amounts like 0.00')
    try {
      await mutate('vehicles.setYear', { vehicleId: vehicle.id, year, reimbursedOperatingCents: op, reimbursedStandbyCents: sb, electHalfStandby: patch.half ?? half })
    } catch (e) {
      fb.error((e as Error).message)
    }
  }

  return (
    <Card
      title="Your taxable benefit"
      description="Calendar year. Report it on your T4A/T4 by the end of February, and the company remits GST on it."
      actions={
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
          {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
      }
    >
      {!b ? (
        <LoadingBlock />
      ) : (
        <div className="grid grid-cols-2 gap-8">
          <div>
            <Row label="Business km" value={b.businessKm.toLocaleString('en-CA')} />
            <Row label="Personal km" value={b.personalKm.toLocaleString('en-CA')} />
            <Row label="Business use" value={`${b.businessUsePct}%`} />
            <Row label={`Available ${b.monthsAvailable} month(s)`} value={`${b.daysAvailable} days`} />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="You reimbursed: operating">{(id) => <MoneyInput id={id} value={opReimb} onChange={(e) => setOpReimb(e.target.value)} onBlur={() => save()} />}</Field>
              <Field label="You reimbursed: standby">{(id) => <MoneyInput id={id} value={sbReimb} onChange={(e) => setSbReimb(e.target.value)} onBlur={() => save()} />}</Field>
            </div>
            <Checkbox
              className="mt-3"
              label="Elect operating benefit = half the standby charge (business use over 50%, notify the company by Dec 31)"
              checked={half}
              onChange={(e) => {
                setHalf(e.target.checked)
                void save({ half: e.target.checked })
              }}
            />
          </div>
          <div>
            <Row label="Standby charge" value={formatMoney(b.standbyChargeCents)} />
            <Row label={`Operating benefit (${b.electHalfStandby ? '½ standby' : `${b.operatingRatePerKmCents}¢/km`})`} value={formatMoney(b.operatingBenefitCents)} />
            <Row label="Taxable benefit" value={formatMoney(b.totalBenefitCents)} strong />
            <Row label="GST the company remits" value={formatMoney(b.gstToRemitCents)} />
            <BenefitNotes b={b} />
          </div>
        </div>
      )}
    </Card>
  )
}

function BenefitNotes({ b }: { b: VehicleBenefit }) {
  if (!b.notes.length) return null
  return <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">{b.notes.map((n) => <li key={n}>{n}</li>)}</ul>
}

function LimitsCard({ vehicle, fiscalYearEndMonth }: { vehicle: VehicleT; fiscalYearEndMonth: number }) {
  const fy = fiscalYearOf(todayIso(), fiscalYearEndMonth)
  const { data: l } = useQuery('vehicles.limits', { vehicleId: vehicle.id, fiscalYearEnd: fy.end })
  if (!l) return null
  if (!l.leaseCostCents && !l.interestCostCents) return null
  return (
    <Card title="CRA limits this fiscal year" description={`${formatDate(l.fiscalYearStart)} to ${formatDate(l.fiscalYearEnd)}. The excess is added back on Schedule 1 automatically.`}>
      <div className="grid grid-cols-2 gap-8">
        {l.leaseCostCents ? (
          <div>
            <Row label="Lease payments recorded" value={formatMoney(l.leaseCostCents)} />
            <Row label="Formula A (monthly cap)" value={formatMoney(l.leaseFormulaACents)} />
            <Row label="Formula B (price cap)" value={formatMoney(l.leaseFormulaBCents)} />
            <Row label="Deductible" value={formatMoney(l.leaseDeductibleCents)} strong />
            <Row label="Not deductible" value={formatMoney(l.leaseExcessCents)} />
            <Row label="GST credit to repay at year end" value={formatMoney(l.leaseItcRepayCents)} />
          </div>
        ) : null}
        {l.interestCostCents ? (
          <div>
            <Row label="Loan interest recorded" value={formatMoney(l.interestCostCents)} />
            <Row label="Cap ($350 a month)" value={formatMoney(l.interestCapCents)} />
            <Row label="Not deductible" value={formatMoney(l.interestExcessCents)} strong />
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function Logbook({ vehicle }: { vehicle: VehicleT }) {
  const fb = useFeedback()
  const year = todayIso().slice(0, 4)
  const [from] = useState(`${Number(year) - 1}-01-01`)
  const trips = useQuery('vehicles.trips', { vehicleId: vehicle.id, from, to: `${year}-12-31` })
  const [date, setDate] = useState(todayIso())
  const [km, setKm] = useState('')
  const [kind, setKind] = useState<'business' | 'personal'>('business')
  const [purpose, setPurpose] = useState('')
  const [route, setRoute] = useState('')
  const [saving, setSaving] = useState(false)

  async function add() {
    const n = Number(km)
    if (!Number.isInteger(n) || n <= 0) return fb.error('Enter whole kilometres.')
    setSaving(true)
    try {
      await mutate('vehicles.addTrip', { vehicleId: vehicle.id, date, km: n, kind, purpose, route })
      setKm('')
      setPurpose('')
      setRoute('')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Logbook" description="CRA expects the date, destination, purpose and kilometres of each business trip. You can also enter a month’s totals as one line." bodyClassName="">
      <div className="grid grid-cols-[150px_100px_130px_1fr_1fr_auto] items-end gap-3 border-b border-line p-4">
        <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Km">{(id) => <Input id={id} inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value)} />}</Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </Select>
          )}
        </Field>
        <Field label="Purpose">{(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={kind === 'business' ? 'Client meeting at Acme' : ''} />}</Field>
        <Field label="From → to">{(id) => <Input id={id} value={route} onChange={(e) => setRoute(e.target.value)} placeholder="Office → Acme, Calgary" />}</Field>
        <Button variant="primary" icon={Plus} onClick={add} loading={saving}>
          Add
        </Button>
      </div>
      {(trips.data ?? []).length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No trips yet.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Date</th>
              <th className={th}>Type</th>
              <th className={th}>Purpose</th>
              <th className={th}>Route</th>
              <th className={thNum}>Km</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {(trips.data ?? []).map((t) => (
              <tr key={t.id} className={tr}>
                <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(t.date)}</td>
                <td className={td}>{t.kind === 'business' ? 'Business' : <span className="text-muted">Personal</span>}</td>
                <td className={td}>{t.purpose}</td>
                <td className={`${td} text-muted`}>{t.route}</td>
                <td className={tdNum}>{t.km.toLocaleString('en-CA')}</td>
                <td className={`${td} w-10`}>
                  <IconButton icon={Trash2} label="Delete trip" onClick={() => mutate('vehicles.deleteTrip', { id: t.id }).catch((e: Error) => fb.error(e.message))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function VehicleModal({ vehicle, onClose }: { vehicle: VehicleT | null; onClose: () => void }) {
  const fb = useFeedback()
  const [name, setName] = useState(vehicle?.name ?? '')
  const [ownership, setOwnership] = useState<'owned' | 'leased'>(vehicle?.ownership ?? 'owned')
  const [startDate, setStartDate] = useState(vehicle?.startDate ?? todayIso())
  const [cost, setCost] = useState(vehicle ? centsToPlain(vehicle.costCents) : '')
  const [msrp, setMsrp] = useState(vehicle ? centsToPlain(vehicle.msrpCents) : '')
  const [lease, setLease] = useState(vehicle ? centsToPlain(vehicle.monthlyLeaseCents) : '')
  const [zero, setZero] = useState(vehicle?.zeroEmission ?? false)
  const [archived, setArchived] = useState(vehicle?.archived ?? false)
  const [saving, setSaving] = useState(false)

  async function save() {
    const money = (s: string) => (s.trim() ? parseMoney(s) : 0)
    const c = money(cost)
    const m = money(msrp)
    const l = money(lease)
    if (c === null || m === null || l === null) return fb.error('Enter amounts like 45000.00')
    setSaving(true)
    try {
      await mutate('vehicles.save', {
        id: vehicle?.id,
        name,
        ownership,
        startDate,
        costCents: c,
        msrpCents: m,
        monthlyLeaseCents: l,
        zeroEmission: zero,
        archived
      })
      fb.success('Vehicle saved')
      onClose()
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
      title={vehicle ? 'Edit vehicle' : 'Add company vehicle'}
      description="Amounts before GST. Record the purchase itself as an expense in the “Company vehicles” category: it becomes a capital asset (CCA class 10 or 10.1)."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-[1fr_170px] gap-4">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="2025 Toyota RAV4" />}</Field>
          <Field label="Available to you since">{(id) => <Input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />}</Field>
        </div>
        <Segmented
          value={ownership}
          onChange={setOwnership}
          options={[
            { value: 'owned', label: 'Company owns it' },
            { value: 'leased', label: 'Company leases it' }
          ]}
        />
        {ownership === 'owned' ? (
          <Field label="Purchase price" hint="Including options, before GST. Used for the standby charge (2% a month).">
            {(id) => <MoneyInput id={id} value={cost} onChange={(e) => setCost(e.target.value)} className="w-56" />}
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Monthly lease payment" hint="Before GST, without insurance.">
              {(id) => <MoneyInput id={id} value={lease} onChange={(e) => setLease(e.target.value)} />}
            </Field>
            <Field label="Manufacturer’s list price" hint="Used for the CRA lease cap (formula B).">
              {(id) => <MoneyInput id={id} value={msrp} onChange={(e) => setMsrp(e.target.value)} />}
            </Field>
          </div>
        )}
        <Checkbox label="Zero-emission vehicle (electric or plug-in hybrid with 7 kWh+)" checked={zero} onChange={(e) => setZero(e.target.checked)} />
        {vehicle ? <Checkbox label="No longer used (archive)" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> : null}
        <Notice tone="info">The logbook decides business use. Under 50% business use, the standby charge isn’t reduced and the company can’t claim the GST on the purchase.</Notice>
      </div>
    </Modal>
  )
}
