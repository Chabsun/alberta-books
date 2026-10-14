import { useMemo, useState } from 'react'
import { CheckCircle2, ExternalLink, Info, Lock } from 'lucide-react'
import { addDays, fiscalYearOf, monthEnd, quarterOf, todayIso } from '../../../shared/dates'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, ErrorNote, Input, LoadingBlock, Notice, Page, PageHeader, Segmented, Select, cx } from '../components/ui'
import { mutate, useQuery } from '../lib/api'
import { formatDate, formatDateTime, formatMoney } from '../lib/format'

type Frequency = 'quarterly' | 'annual' | 'monthly' | 'custom'

function periodsFor(freq: Frequency, fyMonth: number): { from: string; to: string; label: string }[] {
  const today = todayIso()
  const out: { from: string; to: string; label: string }[] = []
  if (freq === 'quarterly') {
    let q = quarterOf(today)
    for (let i = 0; i < 8; i++) {
      out.push({ from: q.start, to: q.end, label: `${formatDate(q.start)} – ${formatDate(q.end)}` })
      q = quarterOf(addDays(q.start, -1))
    }
  } else if (freq === 'annual') {
    let fy = fiscalYearOf(today, fyMonth)
    for (let i = 0; i < 4; i++) {
      out.push({ from: fy.start, to: fy.end, label: `Fiscal year ${formatDate(fy.start)} – ${formatDate(fy.end)}` })
      fy = fiscalYearOf(addDays(fy.start, -1), fyMonth)
    }
  } else if (freq === 'monthly') {
    let end = monthEnd(today)
    for (let i = 0; i < 12; i++) {
      const start = `${end.slice(0, 8)}01`
      out.push({ from: start, to: end, label: new Date(`${start}T12:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }) })
      end = addDays(start, -1)
    }
  }
  return out
}

export default function Gst() {
  const fb = useFeedback()
  const settings = useQuery('settings.get')
  const filings = useQuery('reports.gstFilings')
  const [freq, setFreq] = useState<Frequency>('quarterly')
  const fyMonth = settings.data?.fiscalYearEndMonth ?? 12
  const periods = useMemo(() => periodsFor(freq, fyMonth), [freq, fyMonth])
  const [index, setIndex] = useState(1) // default: the last completed quarter
  const [custom, setCustom] = useState({ from: `${todayIso().slice(0, 4)}-01-01`, to: todayIso() })
  const period = freq === 'custom' ? custom : (periods[Math.min(index, periods.length - 1)] ?? periods[0])
  const valid = Boolean(period?.from && period?.to && period.from <= period.to)
  const { data, error } = useQuery('reports.gstReturn', { from: period.from, to: period.to }, valid)
  const [filing, setFiling] = useState(false)

  async function file() {
    if (!data) return
    const ok = await fb.confirm({
      title: 'Mark this return as filed?',
      body: (
        <div className="space-y-2">
          <p>Do this after you file with CRA. The app will:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              move the net <strong className="text-ink">{formatMoney(Math.abs(data.line109))}</strong> into “GST owing to CRA” (record the payment as a journal entry or bank import),
            </li>
            <li>
              lock your books up to <strong className="text-ink">{formatDate(period.to)}</strong> so the filed numbers can’t change.
            </li>
          </ul>
        </div>
      ),
      confirmLabel: 'Mark as filed'
    })
    if (!ok) return
    setFiling(true)
    try {
      await mutate('reports.fileGstReturn', { from: period.from, to: period.to })
      fb.success('GST return recorded as filed and the period is locked')
    } catch (e) {
      fb.error((e as Error).message)
    } finally {
      setFiling(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="GST return"
        subtitle="Alberta charges GST only (5%). These are the numbers for your GST/HST return (GST34)."
        actions={
          <a
            href="https://www.canada.ca/en/revenue-agency/services/e-services/digital-services-businesses/business-account.html"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink shadow-xs hover:bg-hover"
          >
            CRA My Business Account <ExternalLink className="size-3.5" />
          </a>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented
          value={freq}
          onChange={(f) => {
            setFreq(f)
            setIndex(f === 'quarterly' ? 1 : f === 'monthly' ? 1 : 0)
          }}
          options={[
            { value: 'quarterly', label: 'Quarterly' },
            { value: 'annual', label: 'Annual' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'custom', label: 'Custom' }
          ]}
        />
        {freq === 'custom' ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="w-40" aria-label="From" />
            to
            <Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="w-40" aria-label="To" />
          </div>
        ) : (
          <Select value={index} onChange={(e) => setIndex(Number(e.target.value))} className="w-80" aria-label="Reporting period">
            {periods.map((p, i) => (
              <option key={p.from} value={i}>
                {p.label}
                {i === 0 && freq !== 'annual' ? ' (current)' : ''}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        valid ? <LoadingBlock /> : null
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <Card
            title={`Reporting period ${formatDate(data.from)} – ${formatDate(data.to)}`}
            actions={
              data.filed ? (
                <Badge tone="good">
                  <CheckCircle2 className="size-3.5" /> Filed {formatDateTime(data.filed.filedAt)}
                </Badge>
              ) : data.locked ? (
                <Badge>
                  <Lock className="size-3" /> Locked
                </Badge>
              ) : null
            }
            bodyClassName=""
          >
            <GstLine line="101" label="Sales and other revenue" amount={data.line101} note="Excluding GST" />
            <GstLine line="105" label="Total GST collected" amount={data.line105} note="Line 103 plus adjustments (104)" />
            <GstLine line="108" label="Total input tax credits (ITCs)" amount={data.line108} note="GST you paid on business purchases" />
            <GstLine
              line="109"
              label={data.line109 >= 0 ? 'Net tax owing' : 'Net tax refund'}
              amount={Math.abs(data.line109)}
              strong
              note={data.line109 >= 0 ? 'Pay this to CRA by the due date' : 'CRA owes you this'}
            />
            {!data.filed ? (
              <div className="flex items-center justify-between gap-4 border-t border-line px-5 py-4">
                <p className="text-xs text-muted">
                  {data.locked
                    ? 'Part of this period is before your lock date, so it cannot be marked as filed here.'
                    : 'Enter these numbers in CRA My Business Account (or NETFILE), then mark the return as filed.'}
                </p>
                <Button variant="primary" onClick={file} loading={filing} disabled={data.locked || period.to > todayIso()}>
                  Mark as filed
                </Button>
              </div>
            ) : null}
          </Card>

          <div className="space-y-6">
            <Notice icon={Info} tone="info">
              Most small corporations file <strong>annually</strong> (sales under $1.5M). Your filing frequency is on your GST registration in My Business Account. Can’t mark a period that hasn’t ended yet.
            </Notice>
            <Card title="Filed returns" bodyClassName="">
              {filings.data && filings.data.length > 0 ? (
                <ul>
                  {filings.data.map((f) => (
                    <li key={f.id} className="flex items-center justify-between border-t border-line px-5 py-3 text-sm first:border-t-0">
                      <span>
                        {formatDate(f.periodStart)} – {formatDate(f.periodEnd)}
                      </span>
                      <span className="tabular text-muted">{formatMoney(f.line109)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-5 py-4 text-sm text-muted">No returns marked as filed yet.</div>
              )}
            </Card>
          </div>
        </div>
      )}
    </Page>
  )
}

function GstLine({ line, label, amount, note, strong }: { line: string; label: string; amount: number; note?: string; strong?: boolean }) {
  return (
    <div className={cx('flex items-center justify-between gap-4 border-t border-line px-5 py-4 first:border-t-0', strong && 'bg-accent-soft/50')}>
      <div className="flex items-center gap-4">
        <span className="flex h-7 w-12 items-center justify-center rounded-md bg-subtle text-xs font-semibold text-muted tabular ring-1 ring-line">{line}</span>
        <div>
          <div className={cx('text-sm', strong ? 'font-semibold text-ink' : 'text-ink')}>{label}</div>
          {note ? <div className="text-xs text-muted">{note}</div> : null}
        </div>
      </div>
      <span className={cx('tabular', strong ? 'text-xl font-semibold' : 'text-base')}>{formatMoney(amount)}</span>
    </div>
  )
}
