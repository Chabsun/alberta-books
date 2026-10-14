import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Download } from 'lucide-react'
import { fiscalYearOf, todayIso, addDays } from '../../../shared/dates'
import type { ReportRow } from '../../../shared/types'
import type { Input as ApiInput } from '../../../shared/api'
import { useFeedback } from '../components/feedback'
import { Button, Card, ErrorNote, Input, LoadingBlock, Notice, Page, PageHeader, Segmented, Select, cx } from '../components/ui'
import { call, useQuery } from '../lib/api'
import { formatDate, formatMoney } from '../lib/format'
import { standardPeriods } from '../lib/periods'
import { navigate } from '../lib/router'

type Tab = 'pl' | 'bs' | 'tb' | 'gifi'

export default function Reports() {
  const settings = useQuery('settings.get')
  const [tab, setTab] = useState<Tab>('pl')
  if (!settings.data) return <LoadingBlock />
  const fyMonth = settings.data.fiscalYearEndMonth

  return (
    <Page>
      <PageHeader title="Reports" subtitle={`${settings.data.companyName} · all amounts in CAD`} />
      <div className="mb-5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pl', label: 'Profit and loss' },
            { value: 'bs', label: 'Balance sheet' },
            { value: 'tb', label: 'Trial balance' },
            { value: 'gifi', label: 'T2 (GIFI)' }
          ]}
        />
      </div>
      {tab === 'pl' ? <ProfitAndLoss fyMonth={fyMonth} /> : null}
      {tab === 'bs' ? <BalanceSheetView /> : null}
      {tab === 'tb' ? <TrialBalanceView /> : null}
      {tab === 'gifi' ? <GifiView fyMonth={fyMonth} /> : null}
    </Page>
  )
}

function useExport() {
  const fb = useFeedback()
  return async (input: ApiInput<'reports.exportCsv'>) => {
    try {
      const r = await call('reports.exportCsv', input)
      if (r.savedTo) fb.success('Report exported')
    } catch (e) {
      fb.error((e as Error).message)
    }
  }
}

// ---------------------------------------------------------------- layout pieces

function Statement({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl">{children}</div>
}

function Section({ title, rows, total, totalLabel }: { title: string; rows: ReportRow[]; total: number; totalLabel: string }) {
  return (
    <div className="mb-6">
      <div className="border-b border-line-strong pb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{title}</div>
      {rows.length === 0 ? <div className="py-2 text-sm text-faint">None</div> : null}
      {rows.map((r) => (
        <div key={`${r.accountId}-${r.name}`} className="flex justify-between border-b border-line py-2 text-sm">
          <button
            className={cx('text-left', r.accountId ? 'hover:underline' : 'cursor-default')}
            onClick={() => r.accountId && navigate(`/accounts/${r.accountId}`)}
          >
            {r.code ? <span className="mr-2 text-faint tabular">{r.code}</span> : null}
            {r.name}
          </button>
          <span className="tabular">{formatMoney(r.amountCents)}</span>
        </div>
      ))}
      <div className="flex justify-between py-2 text-sm font-semibold">
        <span>{totalLabel}</span>
        <span className="tabular">{formatMoney(total)}</span>
      </div>
    </div>
  )
}

function PeriodPicker({
  fyMonth,
  from,
  to,
  onChange
}: {
  fyMonth: number
  from: string
  to: string
  onChange: (from: string, to: string) => void
}) {
  const periods = useMemo(() => standardPeriods(fyMonth), [fyMonth])
  const current = periods.find((p) => p.from === from && p.to === to)?.id ?? 'custom'
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <Select
        value={current}
        onChange={(e) => {
          const p = periods.find((x) => x.id === e.target.value)
          if (p) onChange(p.from, p.to)
        }}
        className="w-44"
        aria-label="Period"
      >
        {periods.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom dates</option>
      </Select>
      <Input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} className="w-40" aria-label="From" />
      to
      <Input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} className="w-40" aria-label="To" />
    </div>
  )
}

// ---------------------------------------------------------------- reports

function ProfitAndLoss({ fyMonth }: { fyMonth: number }) {
  const fy = fiscalYearOf(todayIso(), fyMonth)
  const [from, setFrom] = useState(fy.start)
  const [to, setTo] = useState(fy.end)
  const valid = Boolean(from && to && from <= to)
  const { data, error } = useQuery('reports.incomeStatement', { from, to }, valid)
  const exportCsv = useExport()

  return (
    <Card
      title="Profit and loss"
      description={`${formatDate(from)} to ${formatDate(to)}`}
      actions={
        <>
          <PeriodPicker
            fyMonth={fyMonth}
            from={from}
            to={to}
            onChange={(f, t) => {
              setFrom(f)
              setTo(t)
            }}
          />
          <Button icon={Download} onClick={() => exportCsv({ report: 'incomeStatement', from, to })}>
            CSV
          </Button>
        </>
      }
    >
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <Statement>
          <Section title="Income" rows={data.income} total={data.totalIncomeCents} totalLabel="Total income" />
          <Section title="Expenses" rows={data.expenses} total={data.totalExpensesCents} totalLabel="Total expenses" />
          <div className="flex justify-between rounded-lg bg-subtle px-4 py-3 text-base font-semibold">
            <span>{data.netIncomeCents >= 0 ? 'Net income' : 'Net loss'}</span>
            <span className={cx('tabular', data.netIncomeCents < 0 && 'text-danger')}>{formatMoney(data.netIncomeCents)}</span>
          </div>
          <p className="mt-3 text-xs text-muted">Before corporate income tax adjustments (for example, only 50% of meals and entertainment is deductible).</p>
        </Statement>
      )}
    </Card>
  )
}

function BalanceSheetView() {
  const [asOf, setAsOf] = useState(todayIso())
  const { data, error } = useQuery('reports.balanceSheet', { asOf }, Boolean(asOf))
  const exportCsv = useExport()
  return (
    <Card
      title="Balance sheet"
      description={`As of ${formatDate(asOf)}`}
      actions={
        <>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-40" aria-label="As of" />
          <Button icon={Download} onClick={() => exportCsv({ report: 'balanceSheet', asOf })}>
            CSV
          </Button>
        </>
      }
    >
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <Statement>
          <Section title="Assets" rows={data.assets} total={data.totalAssetsCents} totalLabel="Total assets" />
          <Section title="Liabilities" rows={data.liabilities} total={data.totalLiabilitiesCents} totalLabel="Total liabilities" />
          <Section title="Shareholder’s equity" rows={data.equity} total={data.totalEquityCents} totalLabel="Total equity" />
          <div className="flex justify-between rounded-lg bg-subtle px-4 py-3 text-sm font-semibold">
            <span>Total liabilities and equity</span>
            <span className="tabular">{formatMoney(data.totalLiabilitiesCents + data.totalEquityCents)}</span>
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
            {data.balanced ? (
              <>
                <CheckCircle2 className="size-3.5 text-good" /> Assets equal liabilities plus equity: your books balance.
              </>
            ) : (
              <>
                <AlertTriangle className="size-3.5 text-danger" /> The balance sheet does not balance. Please report this.
              </>
            )}
          </div>
        </Statement>
      )}
    </Card>
  )
}

function TrialBalanceView() {
  const [asOf, setAsOf] = useState(todayIso())
  const { data, error } = useQuery('reports.trialBalance', { asOf }, Boolean(asOf))
  const exportCsv = useExport()
  return (
    <Card
      title="Trial balance"
      description="Every account’s balance. Your accountant uses this to prepare year-end statements."
      actions={
        <>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-40" aria-label="As of" />
          <Button icon={Download} onClick={() => exportCsv({ report: 'trialBalance', asOf })}>
            CSV
          </Button>
        </>
      }
      bodyClassName=""
    >
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="w-24 px-5 py-2.5 text-left font-medium">Code</th>
              <th className="px-5 py-2.5 text-left font-medium">Account</th>
              <th className="w-40 px-5 py-2.5 text-right font-medium">Debit</th>
              <th className="w-40 px-5 py-2.5 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.accountId} className="border-t border-line">
                <td className="px-5 py-2 text-muted tabular">{r.code}</td>
                <td className="px-5 py-2">{r.name}</td>
                <td className="px-5 py-2 text-right tabular">{r.debitCents ? formatMoney(r.debitCents) : ''}</td>
                <td className="px-5 py-2 text-right tabular">{r.creditCents ? formatMoney(r.creditCents) : ''}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-line-strong font-semibold">
              <td className="px-5 py-2.5" colSpan={2}>
                Total
              </td>
              <td className="px-5 py-2.5 text-right tabular">{formatMoney(data.totalDebitCents)}</td>
              <td className="px-5 py-2.5 text-right tabular">{formatMoney(data.totalCreditCents)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  )
}

function GifiView({ fyMonth }: { fyMonth: number }) {
  const thisFy = fiscalYearOf(todayIso(), fyMonth)
  const lastFy = fiscalYearOf(addDays(thisFy.start, -1), fyMonth)
  // T2 work happens in the months after year end; otherwise show the current year.
  const [yearEnd, setYearEnd] = useState(todayIso() <= addDays(lastFy.end, 183) ? lastFy.end : thisFy.end)
  const { data, error } = useQuery('reports.gifi', { fiscalYearEnd: yearEnd })
  const exportCsv = useExport()
  const years = [thisFy, lastFy, fiscalYearOf(addDays(lastFy.start, -1), fyMonth)]

  return (
    <div className="space-y-6">
      <Notice icon={AlertTriangle} tone="info">
        These are the figures for your T2 return’s <strong>Schedule 100</strong> (balance sheet) and <strong>Schedule 125</strong> (income statement), grouped by GIFI code. Give the CSV to your accountant or enter it in your T2 software. Have your accountant confirm the GIFI mapping the first year.
      </Notice>
      <div className="flex items-center justify-between">
        <Select value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} className="w-72" aria-label="Fiscal year">
          {years.map((y) => (
            <option key={y.end} value={y.end}>
              Fiscal year ending {formatDate(y.end)}
            </option>
          ))}
        </Select>
        <Button icon={Download} onClick={() => exportCsv({ report: 'gifi', fiscalYearEnd: yearEnd })}>
          Export CSV
        </Button>
      </div>
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <>
          {data.unmapped.length > 0 ? (
            <Notice tone="warn" icon={AlertTriangle}>
              These accounts have no GIFI code, so they are left out: {data.unmapped.join(', ')}. Add codes in the chart of accounts.
            </Notice>
          ) : null}
          <div className="grid gap-6 lg:grid-cols-2">
            <GifiTable title="Schedule 100 · Balance sheet" lines={data.schedule100} />
            <GifiTable title="Schedule 125 · Income statement" lines={data.schedule125} />
          </div>
        </>
      )}
    </div>
  )
}

const TOTAL_CODES = new Set(['2599', '3499', '3620', '3640', '3849', '8299', '9368', '9970', '9999'])

function GifiTable({ title, lines }: { title: string; lines: { gifiCode: string; description: string; amountCents: number }[] }) {
  return (
    <Card title={title} bodyClassName="">
      <table className="w-full text-sm">
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.gifiCode}-${i}`} className={cx('border-t border-line first:border-t-0', TOTAL_CODES.has(l.gifiCode) && 'bg-subtle/70 font-semibold')}>
              <td className="w-16 px-5 py-2 text-muted tabular">{l.gifiCode}</td>
              <td className="px-2 py-2">{l.description}</td>
              <td className="px-5 py-2 text-right tabular">{formatMoney(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
