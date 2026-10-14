import { AlertTriangle, ArrowRight, CheckCircle2, Circle, FileText, HardDriveDownload, Plus, Receipt } from 'lucide-react'
import type { ReactNode } from 'react'
import { IssueList } from '../components/books'
import { IncomeChart } from '../components/IncomeChart'
import { InvoiceStatusBadge, SourceBadge } from '../components/domain'
import { Button, Card, ErrorNote, LoadingBlock, Money, Page, PageHeader, cx } from '../components/ui'
import { useQuery } from '../lib/api'
import { formatDate, formatMoney, relativeTime } from '../lib/format'
import { navigate } from '../lib/router'

function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-4 shadow-xs">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="mt-1.5 text-[24px] leading-tight font-semibold tracking-tight text-ink tabular">{value}</div>
      {note ? <div className={cx('mt-1 text-xs', tone === 'warn' ? 'text-warn' : 'text-muted')}>{note}</div> : null}
    </div>
  )
}

export default function Dashboard() {
  const { data, error } = useQuery('reports.dashboard')
  const settings = useQuery('settings.get')
  const issues = useQuery('issues.list')

  if (error) return <Page><ErrorNote message={error} /></Page>
  if (!data || !settings.data) return <LoadingBlock />

  const d = data
  const today = new Date()
  const greeting = today.getHours() < 12 ? 'Good morning' : today.getHours() < 18 ? 'Good afternoon' : 'Good evening'
  const isEmpty = d.recentEntries.length === 0
  const setupDone = {
    company: settings.data.companyName !== 'My Corporation Ltd.',
    gst: settings.data.gstNumber !== '',
    fiscal: settings.data.fiscalYearEndMonth !== 12,
    activity: !isEmpty
  }

  return (
    <Page>
      <PageHeader
        title={greeting}
        subtitle={`${today.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · Fiscal year from ${formatDate(d.fiscalYearStart)}`}
        actions={
          <>
            <Button icon={Receipt} onClick={() => navigate('/expenses?new=1')}>
              Add expense
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => navigate('/invoices/new')}>
              New invoice
            </Button>
          </>
        }
      />

      {!(setupDone.company && setupDone.gst && setupDone.activity) ? (
        <Card className="mb-6" title="Get set up" description="A few steps and your books are ready.">
          <ol className="grid gap-2 sm:grid-cols-4">
            <SetupStep done={setupDone.company} label="Add your company details" onClick={() => navigate('/settings')} />
            <SetupStep done={setupDone.gst} label="Enter your GST number" onClick={() => navigate('/settings')} />
            <SetupStep done={setupDone.fiscal} label="Set your fiscal year end" onClick={() => navigate('/settings')} />
            <SetupStep done={setupDone.activity} label="Bring in opening balances" onClick={() => navigate('/migrate')} />
          </ol>
        </Card>
      ) : null}

      {issues.data && issues.data.filter((i) => i.code !== 'setup_company').length ? (
        <Card className="mb-6" title="Needs attention" description="Missing paperwork CRA asks for, possible mistakes and coming deadlines." bodyClassName="px-5 py-1">
          <IssueList issues={issues.data.filter((i) => i.code !== 'setup_company')} limit={6} />
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Cash in bank" value={formatMoney(d.cashCents)} note="All bank and savings accounts" />
        <Stat
          label="Owed to you"
          value={formatMoney(d.receivableCents)}
          note={d.overdueCount > 0 ? `${formatMoney(d.overdueCents)} overdue on ${d.overdueCount} invoice${d.overdueCount === 1 ? '' : 's'}` : 'Nothing overdue'}
          tone={d.overdueCount > 0 ? 'warn' : undefined}
        />
        <Stat
          label={d.gstOwingCents >= 0 ? 'GST owing to CRA' : 'GST refund due'}
          value={formatMoney(Math.abs(d.gstOwingCents))}
          note="Collected minus input tax credits"
        />
        <Stat
          label="Net income this fiscal year"
          value={formatMoney(d.netIncomeYtdCents)}
          note={`${formatMoney(d.revenueYtdCents)} in · ${formatMoney(d.expensesYtdCents)} out`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Income and expenses" description="Last 12 months">
          <IncomeChart data={d.monthly} />
        </Card>

        <div className="space-y-6">
          <ShareholderLoan cents={d.shareholderLoanCents} />
          <Card title="Backups" bodyClassName="px-5 py-4">
            <div className="flex items-start gap-3">
              <HardDriveDownload className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="text-sm">
                {d.lastBackupAt ? (
                  <>
                    <div className="text-ink">Last backup {relativeTime(d.lastBackupAt)}</div>
                    <div className="mt-0.5 text-muted">Backed up automatically every day and when you quit.</div>
                  </>
                ) : (
                  <div className="text-ink">No backup yet</div>
                )}
                <button className="mt-2 text-[13px] font-medium text-accent hover:underline" onClick={() => navigate('/settings?section=backups')}>
                  Backup settings
                </button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="Unpaid invoices"
          actions={
            <Button size="sm" variant="ghost" onClick={() => navigate('/invoices')}>
              All invoices <ArrowRight className="size-3.5" />
            </Button>
          }
          bodyClassName=""
        >
          {d.openInvoices.length === 0 ? (
            <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted">
              <FileText className="size-4" /> No unpaid invoices.
            </div>
          ) : (
            <ul>
              {d.openInvoices.map((inv) => (
                <li key={inv.id}>
                  <button
                    onClick={() => navigate(`/invoices/${inv.id}`)}
                    className="flex w-full items-center justify-between gap-3 border-t border-line px-5 py-3 text-left first:border-t-0 hover:bg-subtle"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">{inv.clientName}</div>
                      <div className="text-xs text-muted">
                        {inv.number} · due {formatDate(inv.dueDate)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <InvoiceStatusBadge status={inv.displayStatus} />
                      <Money cents={inv.balanceCents} className="w-24 text-right text-sm font-medium" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent activity"
          actions={
            <Button size="sm" variant="ghost" onClick={() => navigate('/journal')}>
              Journal <ArrowRight className="size-3.5" />
            </Button>
          }
          bodyClassName=""
        >
          {d.recentEntries.length === 0 ? (
            <div className="px-5 py-6 text-sm text-muted">Nothing recorded yet.</div>
          ) : (
            <ul>
              {d.recentEntries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 first:border-t-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{e.memo}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                      {formatDate(e.date)} <SourceBadge source={e.source} />
                    </div>
                  </div>
                  <Money cents={e.totalCents} className="shrink-0 text-sm text-ink" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  )
}

function SetupStep({ done, label, onClick }: { done: boolean; label: string; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className="flex w-full items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 text-left text-sm transition-colors hover:bg-subtle"
      >
        {done ? <CheckCircle2 className="size-4 text-good" /> : <Circle className="size-4 text-faint" />}
        <span className={done ? 'text-muted line-through' : 'text-ink'}>{label}</span>
      </button>
    </li>
  )
}

function ShareholderLoan({ cents }: { cents: number }) {
  const owesYou = cents >= 0
  return (
    <Card title="Shareholder loan" bodyClassName="px-5 py-4">
      <div className="text-[22px] font-semibold tracking-tight tabular">{formatMoney(Math.abs(cents))}</div>
      <p className="mt-1 text-sm text-muted">
        {cents === 0
          ? 'You and the company are square.'
          : owesYou
            ? 'The company owes you this. It can repay you tax-free.'
            : 'You owe the company this amount.'}
      </p>
      {!owesYou ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Repay it before the end of the fiscal year after the one it arose in, or it may be taxed as income (s. 15(2)). Ask your accountant.
          </span>
        </div>
      ) : null}
    </Card>
  )
}
