import { useState } from 'react'
import { FileText, Plus, Search } from 'lucide-react'
import { InvoiceStatusBadge } from '../components/domain'
import { Button, Card, EmptyState, ErrorNote, Input, LoadingBlock, Money, Page, PageHeader, Segmented, td, tdNum, th, thNum, trClickable } from '../components/ui'
import { useQuery } from '../lib/api'
import { formatDate, formatMoney } from '../lib/format'
import { navigate } from '../lib/router'
import type { InvoiceSummary } from '../../../shared/types'

type Filter = 'all' | 'draft' | 'unpaid' | 'overdue' | 'paid' | 'void'

const FILTERS: { value: Filter; label: string; test: (i: InvoiceSummary) => boolean }[] = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'draft', label: 'Drafts', test: (i) => i.status === 'draft' },
  { value: 'unpaid', label: 'Unpaid', test: (i) => i.status === 'issued' && i.balanceCents > 0 },
  { value: 'overdue', label: 'Overdue', test: (i) => i.displayStatus === 'overdue' },
  { value: 'paid', label: 'Paid', test: (i) => i.displayStatus === 'paid' },
  { value: 'void', label: 'Void', test: (i) => i.status === 'void' }
]

export default function Invoices() {
  const { data, error } = useQuery('invoices.list')
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')

  const all = data ?? []
  const outstanding = all.filter((i) => i.status === 'issued').reduce((s, i) => s + i.balanceCents, 0)
  const test = FILTERS.find((f) => f.value === filter)!.test
  const needle = q.trim().toLowerCase()
  const shown = all.filter((i) => test(i) && (!needle || i.clientName.toLowerCase().includes(needle) || (i.number ?? '').toLowerCase().includes(needle)))

  return (
    <Page>
      <PageHeader
        title="Invoices"
        subtitle={data ? `${formatMoney(outstanding)} outstanding` : undefined}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => navigate('/invoices/new')}>
            New invoice
          </Button>
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="No invoices yet"
            body="Create your first invoice. GST is added automatically, and nothing reaches your books until you issue it."
            action={
              <Button variant="primary" icon={Plus} onClick={() => navigate('/invoices/new')}>
                New invoice
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({
                value: f.value,
                label: (
                  <span>
                    {f.label} <span className="ml-0.5 text-faint">{all.filter(f.test).length}</span>
                  </span>
                )
              }))}
            />
            <div className="relative w-64">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-faint" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or number" className="pl-9" />
            </div>
          </div>
          <Card bodyClassName="">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Number</th>
                  <th className={th}>Client</th>
                  <th className={th}>Date</th>
                  <th className={th}>Due</th>
                  <th className={th}>Status</th>
                  <th className={thNum}>Total</th>
                  <th className={thNum}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} className={trClickable} onClick={() => navigate(i.status === 'draft' ? `/invoices/${i.id}/edit` : `/invoices/${i.id}`)}>
                    <td className={`${td} font-medium`}>{i.number ?? <span className="text-faint">Draft</span>}</td>
                    <td className={td}>{i.clientName}</td>
                    <td className={`${td} text-muted`}>{formatDate(i.issueDate)}</td>
                    <td className={`${td} text-muted`}>{formatDate(i.dueDate)}</td>
                    <td className={td}>
                      <InvoiceStatusBadge status={i.displayStatus} />
                    </td>
                    <td className={tdNum}>
                      <Money cents={i.totalCents} />
                    </td>
                    <td className={`${tdNum} font-medium`}>{i.status === 'issued' ? <Money cents={i.balanceCents} /> : <span className="text-faint">—</span>}</td>
                  </tr>
                ))}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted">
                      No invoices match.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </Page>
  )
}
