import { useState } from 'react'
import { todayIso } from '../../../shared/dates'
import { BackLink, SourceBadge } from '../components/domain'
import { Card, ErrorNote, Input, LoadingBlock, Money, Page, PageHeader, td, tdNum, th, thNum, tr } from '../components/ui'
import { useQuery } from '../lib/api'
import { formatDate } from '../lib/format'

export default function AccountLedger({ id }: { id: number }) {
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`)
  const [to, setTo] = useState(todayIso())
  const valid = from && to && from <= to
  const { data, error } = useQuery('reports.ledger', { accountId: id, from, to }, Boolean(valid))

  return (
    <Page>
      <PageHeader
        back={<BackLink to="/accounts" label="Chart of accounts" />}
        title={data ? `${data.account.code} · ${data.account.name}` : 'Account'}
        subtitle={data?.account.gifiCode ? `GIFI ${data.account.gifiCode}` : undefined}
        actions={
          <div className="flex items-center gap-2 text-sm text-muted">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" />
            to
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
          </div>
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <Card bodyClassName="">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Date</th>
                <th className={th}>Description</th>
                <th className={th}>Source</th>
                <th className={thNum}>Debit</th>
                <th className={thNum}>Credit</th>
                <th className={thNum}>Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className={`${tr} bg-subtle/60`}>
                <td className={`${td} text-muted`}>{formatDate(data.from)}</td>
                <td className={`${td} text-muted`} colSpan={4}>
                  Opening balance
                </td>
                <td className={`${tdNum} font-medium`}>
                  <Money cents={data.openingBalanceCents} signed />
                </td>
              </tr>
              {data.rows.map((r, i) => (
                <tr key={`${r.entryId}-${i}`} className={tr}>
                  <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(r.date)}</td>
                  <td className={td}>{r.memo}</td>
                  <td className={td}>
                    <SourceBadge source={r.source} />
                  </td>
                  <td className={tdNum}>{r.debitCents ? <Money cents={r.debitCents} /> : ''}</td>
                  <td className={tdNum}>{r.creditCents ? <Money cents={r.creditCents} /> : ''}</td>
                  <td className={tdNum}>
                    <Money cents={r.runningBalanceCents} signed />
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 ? (
                <tr className={tr}>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                    No transactions in this period.
                  </td>
                </tr>
              ) : null}
              <tr className="border-t-2 border-line-strong">
                <td className={`${td} font-medium`} colSpan={5}>
                  Closing balance
                </td>
                <td className={`${tdNum} font-semibold`}>
                  <Money cents={data.closingBalanceCents} signed />
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  )
}
