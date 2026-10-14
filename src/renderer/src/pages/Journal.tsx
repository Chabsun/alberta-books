import { useEffect, useState } from 'react'
import { BookOpen, ChevronRight, Download, Plus, Undo2, X } from 'lucide-react'
import { todayIso } from '../../../shared/dates'
import type { Account, AccountRole, JournalEntry } from '../../../shared/types'
import { AccountSelect, SourceBadge } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Button, Card, EmptyState, ErrorNote, Field, IconButton, Input, LoadingBlock, Modal, Money, MoneyInput, Page, PageHeader, Select, cx } from '../components/ui'
import { call, mutate, useQuery } from '../lib/api'
import { formatDate, formatMoney, parseMoney } from '../lib/format'
import { navigate, queryParam, usePath } from '../lib/router'

interface Preset {
  id: string
  label: string
  memo: string
  hint: string
  debit: AccountRole
  credit: AccountRole
}

const PRESETS: Preset[] = [
  {
    id: 'opening',
    label: 'Opening bank balance',
    memo: 'Opening balance',
    hint: 'Starting these books with money already in the bank? Enter the balance on your start date. If the company had earlier years, ask your accountant for the full opening balance sheet.',
    debit: 'bank',
    credit: 'retained_earnings'
  },
  {
    id: 'shares',
    label: 'Shares issued at incorporation',
    memo: 'Common shares issued',
    hint: 'Money you paid the company for its shares.',
    debit: 'bank',
    credit: 'share_capital'
  },
  {
    id: 'lend',
    label: 'I put money into the company',
    memo: 'Shareholder loan – advance from owner',
    hint: 'Money you lent the company. It can repay you later tax-free.',
    debit: 'bank',
    credit: 'shareholder_loan'
  },
  {
    id: 'repay',
    label: 'The company repaid me',
    memo: 'Shareholder loan – repayment to owner',
    hint: 'The company paying back money you lent it.',
    debit: 'shareholder_loan',
    credit: 'bank'
  },
  {
    id: 'dividend',
    label: 'Dividend paid to me',
    memo: 'Dividend paid',
    hint: 'Paying yourself a dividend. Remember the T5 slip by the end of February.',
    debit: 'dividends',
    credit: 'bank'
  },
  {
    id: 'gst',
    label: 'GST payment to CRA',
    memo: 'GST payment to CRA',
    hint: 'Paying the GST owing from a filed return.',
    debit: 'gst_owing',
    credit: 'bank'
  }
]

export default function Journal() {
  const path = usePath()
  const fb = useFeedback()
  const { data, error } = useQuery('journal.list', { limit: 1000 })
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState(queryParam(path, 'preset') !== null)
  const [preset, setPreset] = useState<string | null>(queryParam(path, 'preset'))
  const [exportFrom, setExportFrom] = useState(`${todayIso().slice(0, 4)}-01-01`)
  const [exportTo, setExportTo] = useState(todayIso())

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  async function reverse(e: JournalEntry) {
    const ok = await fb.confirm({
      title: `Reverse entry #${e.id}?`,
      body: 'A new entry dated today with debits and credits swapped cancels it out. The original stays for your records.',
      confirmLabel: 'Reverse entry',
      danger: true
    })
    if (!ok) return
    try {
      await mutate('journal.reverse', { id: e.id, date: todayIso() })
      fb.success('Entry reversed')
    } catch (err) {
      fb.error((err as Error).message)
    }
  }

  async function exportCsv() {
    try {
      const r = await call('reports.exportCsv', { report: 'journal', from: exportFrom, to: exportTo })
      if (r.savedTo) fb.success('Journal exported')
    } catch (err) {
      fb.error((err as Error).message)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Journal"
        subtitle="Every transaction in your books, newest first. Entries are permanent; mistakes are fixed by reversing."
        actions={
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => {
              setPreset(null)
              setOpen(true)
            }}
          >
            New entry
          </Button>
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={BookOpen} title="No entries yet" body="Invoices, payments and expenses appear here automatically. Use a new entry for things like an opening balance, dividends or money you lend the company." />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-end gap-2 text-sm text-muted">
            Export
            <Input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} className="w-40" aria-label="From" />
            to
            <Input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} className="w-40" aria-label="To" />
            <Button icon={Download} onClick={exportCsv}>
              CSV
            </Button>
          </div>
          <Card bodyClassName="">
            <ul>
              {data.map((e) => {
                const isOpen = expanded.has(e.id)
                return (
                  <li key={e.id} className="border-t border-line first:border-t-0">
                    <button onClick={() => toggle(e.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle" aria-expanded={isOpen}>
                      <ChevronRight className={cx('size-4 shrink-0 text-faint transition-transform', isOpen && 'rotate-90')} />
                      <span className="w-24 shrink-0 text-sm text-muted">{formatDate(e.date)}</span>
                      <span className="w-12 shrink-0 text-xs text-faint tabular">#{e.id}</span>
                      <span className={cx('min-w-0 flex-1 truncate text-sm', e.reversedById ? 'text-faint line-through' : 'text-ink')}>{e.memo}</span>
                      <SourceBadge source={e.source} />
                      <Money cents={e.totalCents} className="w-28 shrink-0 text-right text-sm font-medium" />
                    </button>
                    {isOpen ? (
                      <div className="bg-subtle/60 px-4 pt-1 pb-3 pl-11">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-muted">
                              <th className="py-1.5 text-left font-medium">Account</th>
                              <th className="py-1.5 text-left font-medium">Memo</th>
                              <th className="w-32 py-1.5 text-right font-medium">Debit</th>
                              <th className="w-32 py-1.5 text-right font-medium">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {e.lines.map((l, i) => (
                              <tr key={i} className="border-t border-line">
                                <td className={cx('py-1.5', l.creditCents > 0 && 'pl-6')}>
                                  <button className="hover:underline" onClick={() => navigate(`/accounts/${l.accountId}`)}>
                                    <span className="text-faint tabular">{l.accountCode}</span> {l.accountName}
                                  </button>
                                </td>
                                <td className="py-1.5 text-muted">{l.memo}</td>
                                <td className="py-1.5 text-right tabular">{l.debitCents ? formatMoney(l.debitCents) : ''}</td>
                                <td className="py-1.5 text-right tabular">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
                          {e.reversesId ? <span>Reverses entry #{e.reversesId}.</span> : null}
                          {e.reversedById ? <span>Reversed by entry #{e.reversedById}.</span> : null}
                          {(e.source === 'manual' || e.source === 'import') && !e.reversedById ? (
                            <Button size="sm" variant="ghost" icon={Undo2} onClick={() => reverse(e)}>
                              Reverse
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Card>
        </>
      )}
      <EntryModal
        open={open}
        presetId={preset}
        onClose={() => {
          setOpen(false)
          if (queryParam(path, 'preset') !== null) navigate('/journal')
        }}
      />
    </Page>
  )
}

interface LineDraft {
  key: number
  accountId: number | ''
  debit: string
  credit: string
  memo: string
}

let seq = 1
const blank = (): LineDraft => ({ key: seq++, accountId: '', debit: '', credit: '', memo: '' })

function EntryModal({ open, presetId, onClose }: { open: boolean; presetId: string | null; onClose: () => void }) {
  const fb = useFeedback()
  const accounts = useQuery('accounts.list')
  const [date, setDate] = useState(todayIso())
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blank(), blank()])
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const list = accounts.data ?? []

  function applyPreset(id: string | null, accs: Account[]) {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) {
      setMemo('')
      setHint(null)
      setLines([blank(), blank()])
      return
    }
    const byRole = (r: AccountRole) => accs.find((a) => a.role === r)?.id ?? ''
    setMemo(p.memo)
    setHint(p.hint)
    setLines([
      { ...blank(), accountId: byRole(p.debit) },
      { ...blank(), accountId: byRole(p.credit) }
    ])
  }

  useEffect(() => {
    if (!open || !accounts.data) return
    setDate(todayIso())
    setError(null)
    applyPreset(presetId, accounts.data)
  }, [open, presetId, accounts.data])

  // For a two-line entry, typing one side fills the other.
  const parsed = lines.map((l) => ({ d: l.debit ? parseMoney(l.debit) : 0, c: l.credit ? parseMoney(l.credit) : 0 }))
  const totalD = parsed.reduce((s, p) => s + (p.d ?? 0), 0)
  const totalC = parsed.reduce((s, p) => s + (p.c ?? 0), 0)
  const diff = totalD - totalC

  function set(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => {
      const me = { ...ls.find((l) => l.key === key)!, ...patch }
      return ls.map((l) => {
        if (l.key === key) return me
        if (ls.length !== 2) return l
        if (patch.debit !== undefined && !l.debit) return { ...l, credit: me.debit }
        if (patch.credit !== undefined && !l.credit) return { ...l, debit: me.credit }
        return l
      })
    })
  }

  async function save() {
    if (!memo.trim()) return setError('Describe the entry.')
    if (parsed.some((p) => p.d === null || p.c === null)) return setError('Check the amounts: use numbers like 1,250.00.')
    if (lines.some((l, i) => (parsed[i].d! > 0 || parsed[i].c! > 0) && l.accountId === '')) return setError('Choose an account on every line with an amount.')
    if (lines.some((_, i) => parsed[i].d! > 0 && parsed[i].c! > 0)) return setError('Each line takes a debit or a credit, not both.')
    if (diff !== 0) return setError(`Debits and credits must be equal (off by ${formatMoney(Math.abs(diff))}).`)
    const used = lines.filter((_, i) => parsed[i].d! > 0 || parsed[i].c! > 0)
    if (used.length < 2) return setError('Enter at least two lines.')
    setSaving(true)
    try {
      await mutate('journal.create', {
        date,
        memo,
        lines: used.map((l) => {
          const i = lines.indexOf(l)
          return { accountId: l.accountId as number, debitCents: parsed[i].d!, creditCents: parsed[i].c!, memo: l.memo }
        })
      })
      fb.success('Entry posted')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New journal entry"
      width="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={diff !== 0 || totalD === 0}>
            Post entry
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Common entries">
          {(id) => (
            <Select id={id} value={presetId ?? ''} onChange={(e) => applyPreset(e.target.value || null, list)}>
              <option value="">Blank entry</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {hint ? <p className="-mt-2 text-xs text-muted">{hint}</p> : null}
        <div className="grid grid-cols-[170px_1fr] gap-4">
          <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Description">{(id) => <Input id={id} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
        </div>

        <div className="rounded-lg border border-line">
          <div className="grid grid-cols-[1fr_130px_130px_32px] gap-2 border-b border-line px-3 py-2 text-xs font-medium text-muted">
            <span>Account</span>
            <span className="text-right">Debit</span>
            <span className="text-right">Credit</span>
            <span />
          </div>
          <div className="space-y-2 p-3">
            {lines.map((l) => (
              <div key={l.key} className="grid grid-cols-[1fr_130px_130px_32px] gap-2">
                <AccountSelect accounts={list} value={l.accountId} onChange={(e) => set(l.key, { accountId: e.target.value ? Number(e.target.value) : '' })} aria-label="Account" />
                <MoneyInput value={l.debit} onChange={(e) => set(l.key, { debit: e.target.value })} aria-label="Debit" />
                <MoneyInput value={l.credit} onChange={(e) => set(l.key, { credit: e.target.value })} aria-label="Credit" />
                <IconButton icon={X} label="Remove line" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="disabled:opacity-30" />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2">
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, blank()])}>
              Add line
            </Button>
            <div className="flex items-center gap-6 text-sm tabular">
              <span className="text-muted">
                Debits <span className="text-ink">{formatMoney(totalD)}</span>
              </span>
              <span className="text-muted">
                Credits <span className="text-ink">{formatMoney(totalC)}</span>
              </span>
              <span className={diff === 0 ? 'text-good' : 'text-danger'}>{diff === 0 ? (totalD ? 'Balanced' : '') : `Off by ${formatMoney(Math.abs(diff))}`}</span>
            </div>
          </div>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <p className="text-xs text-muted">
          A debit increases assets (like the bank), expenses and dividends. A credit increases income, liabilities (like loans and GST owing) and equity.
        </p>
      </div>
    </Modal>
  )
}
