import { ArrowLeft } from 'lucide-react'
import type { ComponentProps } from 'react'
import type { Account, AccountType, EntrySource, InvoiceDisplayStatus } from '../../../shared/types'
import { navigate } from '../lib/router'
import { Badge, Select, type Tone } from './ui'

const invoiceTones: Record<InvoiceDisplayStatus, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  open: { tone: 'info', label: 'Awaiting payment' },
  partial: { tone: 'info', label: 'Partly paid' },
  overdue: { tone: 'warn', label: 'Overdue' },
  paid: { tone: 'good', label: 'Paid' },
  void: { tone: 'neutral', label: 'Void' }
}

export function InvoiceStatusBadge({ status }: { status: InvoiceDisplayStatus }) {
  const s = invoiceTones[status]
  return <Badge tone={s.tone}>{s.label}</Badge>
}

const sourceLabels: Record<EntrySource, string> = {
  manual: 'Journal',
  invoice: 'Invoice',
  payment: 'Payment',
  expense: 'Expense',
  gst_return: 'GST return',
  import: 'Bank import',
  reversal: 'Reversal'
}

export function SourceBadge({ source }: { source: EntrySource }) {
  const tone: Tone = source === 'reversal' ? 'warn' : source === 'manual' ? 'accent' : 'neutral'
  return <Badge tone={tone}>{sourceLabels[source]}</Badge>
}

export const TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses'
}

const TYPE_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']

/** Account picker grouped by type. `allow` limits which accounts are offered. */
export function AccountSelect({
  accounts,
  allow,
  placeholder = 'Choose an account…',
  ...rest
}: Omit<ComponentProps<'select'>, 'children'> & {
  accounts: Account[]
  allow?: (a: Account) => boolean
  placeholder?: string
}) {
  const list = accounts.filter((a) => !a.archived && (!allow || allow(a)))
  return (
    <Select {...rest}>
      <option value="">{placeholder}</option>
      {TYPE_ORDER.map((type) => {
        const group = list.filter((a) => a.type === type)
        if (group.length === 0) return null
        return (
          <optgroup key={type} label={TYPE_LABELS[type]}>
            {group.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </optgroup>
        )
      })}
    </Select>
  )
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </button>
  )
}
