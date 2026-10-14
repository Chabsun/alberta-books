import { useState } from 'react'
import { Archive, CheckCircle2, Download, Package } from 'lucide-react'
import { addDays, fiscalYearOf, todayIso } from '../../../shared/dates'
import { CCA_CLASSES, type CcaClassId } from '../../../shared/taxRules'
import type { Asset } from '../../../shared/types'
import { IssueList } from '../components/books'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, Field, Input, LoadingBlock, Modal, Money, MoneyInput, Page, PageHeader, Select, td, tdNum, th, thNum, tr } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { formatDate, formatMoney, parseMoney } from '../lib/format'

export default function YearEnd() {
  const settings = useQuery('settings.get')
  const [chosen, setChosen] = useState<string | null>(null)
  if (!settings.data) return <LoadingBlock />
  const fyEndMonth = settings.data.fiscalYearEndMonth
  const current = fiscalYearOf(todayIso(), fyEndMonth)
  const years = [current, fiscalYearOf(addDays(current.start, -1), fyEndMonth), fiscalYearOf(addDays(current.start, -366), fyEndMonth)]
  // Within six months after year end, last year is the one being closed.
  const defaultYear = todayIso() <= addDays(years[1]!.end, 183) ? years[1]! : current
  const fy = years.find((y) => y.end === chosen) ?? defaultYear

  return (
    <Page>
      <PageHeader
        title="Year end"
        subtitle="Everything for the T2: tax adjustments, capital cost allowance, and a package for your accountant."
        actions={
          <Select value={fy.end} onChange={(e) => setChosen(e.target.value)} className="w-72">
            {years.map((y) => (
              <option key={y.end} value={y.end}>
                {formatDate(y.start)} – {formatDate(y.end)}
              </option>
            ))}
          </Select>
        }
      />
      <div className="space-y-5">
        <PackageCard fiscalYearEnd={fy.end} />
        <div className="grid grid-cols-2 gap-5">
          <TaxCard fiscalYearEnd={fy.end} />
          <OpenItems />
        </div>
        <CcaCard fiscalYearEnd={fy.end} />
      </div>
    </Page>
  )
}

function PackageCard({ fiscalYearEnd }: { fiscalYearEnd: string }) {
  const fb = useFeedback()
  const [busy, setBusy] = useState(false)
  async function exportIt() {
    setBusy(true)
    try {
      const r = await call('package.export', { fiscalYearEnd })
      if (r.savedTo) fb.success(`Saved with ${r.receipts} receipt${r.receipts === 1 ? '' : 's'}: ${r.savedTo}`)
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Package className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-ink">Accountant package</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            One zip file your accountant can use whatever software they have: financial statements (PDF), an Excel workbook with every schedule, CSV files, ready-to-import
            files for TaxCycle, Taxprep, CaseWare, QuickBooks Online and Xero (trial balance with GIFI codes and the full journal), and all receipts.
          </p>
        </div>
        <Button variant="primary" icon={Download} onClick={exportIt} loading={busy}>
          Export package
        </Button>
      </div>
    </Card>
  )
}

function TaxCard({ fiscalYearEnd }: { fiscalYearEnd: string }) {
  const { data: t } = useQuery('tax.adjustments', { fiscalYearEnd })
  return (
    <Card title="Net income for tax (Schedule 1 estimate)" description="From net income in the books to net income for tax.">
      {!t ? (
        <LoadingBlock />
      ) : (
        <div className="text-sm">
          <Line label="Net income per books" cents={t.netIncomeBooksCents} />
          {t.addBacks.map((a) => (
            <Line key={a.label} label={`Add: ${a.label}`} cents={a.amountCents} note={a.note} muted />
          ))}
          {t.deductions.map((d) => (
            <Line key={d.label} label={`Deduct: ${d.label}`} cents={-d.amountCents} note={d.note} muted />
          ))}
          <Line label="Net income for tax" cents={t.netIncomeForTaxCents} strong />
          {t.donationsCents ? <Line label="Donations (Schedule 2, deducted separately)" cents={t.donationsCents} muted /> : null}
          {t.notes.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted">{t.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        </div>
      )}
    </Card>
  )
}

function Line({ label, cents, note, muted, strong }: { label: string; cents: number; note?: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-4 py-1.5 ${strong ? 'mt-1 border-t border-line pt-2.5 font-semibold' : ''}`}>
      <div>
        <div className={muted ? 'text-muted' : 'text-ink'}>{label}</div>
        {note ? <div className="text-xs text-faint">{note}</div> : null}
      </div>
      <Money cents={cents} className="text-ink" />
    </div>
  )
}

function OpenItems() {
  const { data } = useQuery('issues.list')
  return (
    <Card title="Before you send it" description="What the app found that you or your accountant should look at.">
      {!data ? (
        <LoadingBlock />
      ) : data.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-good">
          <CheckCircle2 className="size-4" /> Nothing to fix.
        </div>
      ) : (
        <IssueList issues={data} limit={8} />
      )}
    </Card>
  )
}

function CcaCard({ fiscalYearEnd }: { fiscalYearEnd: string }) {
  const { data: s } = useQuery('cca.schedule', { fiscalYearEnd })
  const assets = useQuery('cca.assets')
  const [opening, setOpening] = useState(false)
  const [disposing, setDisposing] = useState<Asset | null>(null)
  return (
    <Card
      title="Capital cost allowance (Schedule 8)"
      description="Equipment, computers, software and vehicles are written off through CCA. Assets come from expenses in capital categories."
      actions={<Button onClick={() => setOpening(true)}>Opening balances</Button>}
      bodyClassName=""
    >
      {!s ? (
        <LoadingBlock />
      ) : (
        <>
          {s.rows.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">No capital assets this year.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Class</th>
                  <th className={thNum}>Opening UCC</th>
                  <th className={thNum}>Additions</th>
                  <th className={thNum}>Disposals</th>
                  <th className={thNum}>Rate</th>
                  <th className={thNum}>CCA</th>
                  <th className={thNum}>Closing UCC</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.ccaClass} className={tr}>
                    <td className={td}>
                      <div className="font-medium">Class {r.ccaClass}</div>
                      <div className="text-xs text-muted">{r.label}</div>
                    </td>
                    <td className={tdNum}><Money cents={r.openingUccCents} /></td>
                    <td className={tdNum}><Money cents={r.additionsCents} /></td>
                    <td className={tdNum}><Money cents={r.disposalsCents} /></td>
                    <td className={tdNum}>{r.ratePct}%</td>
                    <td className={`${tdNum} font-medium`}>
                      <Money cents={r.ccaCents} />
                      {r.recaptureCents ? <div className="text-xs text-warn">Recapture {formatMoney(r.recaptureCents)}</div> : null}
                      {r.terminalLossCents ? <div className="text-xs text-info">Terminal loss {formatMoney(r.terminalLossCents)}</div> : null}
                    </td>
                    <td className={tdNum}><Money cents={r.closingUccCents} /></td>
                  </tr>
                ))}
                <tr className={tr}>
                  <td className={`${td} font-semibold`} colSpan={5}>Total CCA</td>
                  <td className={`${tdNum} font-semibold`}><Money cents={s.totalCcaCents} /></td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}
          {s.notes.length ? <ul className="list-disc space-y-1 border-t border-line py-3 pr-5 pl-10 text-xs text-muted">{s.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          {(assets.data ?? []).length ? (
            <div className="border-t border-line">
              <div className="px-5 pt-4 pb-1 text-[13px] font-medium text-ink">Assets</div>
              <table className="w-full">
                <tbody>
                  {(assets.data ?? []).map((a) => (
                    <tr key={a.id} className={tr}>
                      <td className={td}>{a.description}</td>
                      <td className={`${td} text-muted`}>Class {a.ccaClass}</td>
                      <td className={`${td} text-muted`}>In use {formatDate(a.availableDate)}</td>
                      <td className={tdNum}><Money cents={a.costCents} /></td>
                      <td className={`${td} w-40 text-right`}>
                        {a.disposedDate ? (
                          <Badge>Sold {formatDate(a.disposedDate)}</Badge>
                        ) : (
                          <Button size="sm" variant="ghost" icon={Archive} onClick={() => setDisposing(a)}>
                            Sold / disposed
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
      {opening ? <OpeningUccModal onClose={() => setOpening(false)} /> : null}
      {disposing ? <DisposeModal asset={disposing} onClose={() => setDisposing(null)} /> : null}
    </Card>
  )
}

function OpeningUccModal({ onClose }: { onClose: () => void }) {
  const fb = useFeedback()
  const [ccaClass, setCcaClass] = useState<CcaClassId>('50')
  const [asOf, setAsOf] = useState('')
  const [ucc, setUcc] = useState('')
  async function save() {
    const cents = parseMoney(ucc)
    if (cents === null || cents < 0) return fb.error('Enter the UCC from last year’s Schedule 8.')
    if (!asOf) return fb.error('Enter the year-end date it was at.')
    try {
      await mutate('cca.setOpening', { ccaClass, asOf, uccCents: cents })
      fb.success(`Opening UCC saved for class ${ccaClass}`)
      onClose()
    } catch (e) {
      fb.error((e as Error).message)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="sm"
      title="Opening UCC"
      description="Undepreciated capital cost per class at the end of the last year filed (from your previous T2 Schedule 8)."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Class">
          {(id) => (
            <Select id={id} value={ccaClass} onChange={(e) => setCcaClass(e.target.value as CcaClassId)}>
              {Object.values(CCA_CLASSES).filter((c) => c.id !== '10.1').map((c) => (
                <option key={c.id} value={c.id}>
                  Class {c.number} · {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="At year end">{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}</Field>
        <Field label="UCC">{(id) => <MoneyInput id={id} value={ucc} onChange={(e) => setUcc(e.target.value)} />}</Field>
      </div>
    </Modal>
  )
}

function DisposeModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const fb = useFeedback()
  const [date, setDate] = useState(todayIso())
  const [proceeds, setProceeds] = useState('0.00')
  async function save() {
    const cents = parseMoney(proceeds)
    if (cents === null || cents < 0) return fb.error('Enter what you sold it for (0 if thrown away).')
    try {
      await mutate('cca.dispose', { id: asset.id, date, proceedsCents: cents })
      fb.success('Recorded. CCA now accounts for the sale.')
      onClose()
    } catch (e) {
      fb.error((e as Error).message)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width="sm"
      title={`Sold or disposed: ${asset.description}`}
      description="For CCA only (recapture or terminal loss). Record the money received through the bank feed as usual."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Proceeds (before GST)">{(id) => <MoneyInput id={id} value={proceeds} onChange={(e) => setProceeds(e.target.value)} />}</Field>
      </div>
    </Modal>
  )
}
