import { useEffect, useState } from 'react'
import { Lock, Plus } from 'lucide-react'
import type { Account, AccountType } from '../../../shared/types'
import { TYPE_LABELS } from '../components/domain'
import { useFeedback } from '../components/feedback'
import { Badge, Button, Card, Checkbox, ErrorNote, Field, Input, LoadingBlock, Modal, Money, Page, PageHeader, Select, td, tdNum, th, thNum, trClickable } from '../components/ui'
import { mutate, useQuery } from '../lib/api'
import { navigate } from '../lib/router'

const ORDER: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']

export default function Accounts() {
  const [showArchived, setShowArchived] = useState(false)
  const { data, error } = useQuery('accounts.list', { includeArchived: showArchived })
  const [editing, setEditing] = useState<Account | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <Page>
      <PageHeader
        title="Chart of accounts"
        subtitle="Click an account to see every transaction in it. GIFI codes map each account to your T2 corporate return."
        actions={
          <>
            <Checkbox label="Show archived" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setEditing(null)
                setOpen(true)
              }}
            >
              New account
            </Button>
          </>
        }
      />
      {error ? <ErrorNote message={error} /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-6">
          {ORDER.map((type) => {
            const rows = data.filter((a) => a.type === type)
            return (
              <Card key={type} title={TYPE_LABELS[type]} bodyClassName="">
                <table className="w-full table-fixed">
                  <thead>
                    <tr>
                      <th className={`${th} w-24`}>Code</th>
                      <th className={th}>Name</th>
                      <th className={`${th} w-24`}>GIFI</th>
                      <th className={`${th} w-20`}></th>
                      <th className={`${thNum} w-40`}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id} className={trClickable} onClick={() => navigate(`/accounts/${a.id}`)}>
                        <td className={`${td} text-muted tabular`}>{a.code}</td>
                        <td className={td}>
                          <span className={a.archived ? 'text-faint' : ''}>{a.name}</span>
                          {a.isBank ? <Badge className="ml-2">Bank</Badge> : null}
                          {a.archived ? <Badge className="ml-2">Archived</Badge> : null}
                        </td>
                        <td className={`${td} text-muted tabular`}>{a.gifiCode ?? '—'}</td>
                        <td className={`${td} text-right`}>
                          <button
                            className="text-xs text-muted hover:text-ink"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditing(a)
                              setOpen(true)
                            }}
                          >
                            Edit
                          </button>
                        </td>
                        <td className={tdNum}>{a.hasActivity ? <Money cents={a.balanceCents} /> : <span className="text-faint">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          })}
        </div>
      )}
      <AccountModal open={open} account={editing} onClose={() => setOpen(false)} />
    </Page>
  )
}

function AccountModal({ open, account, onClose }: { open: boolean; account: Account | null; onClose: () => void }) {
  const fb = useFeedback()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('expense')
  const [gifi, setGifi] = useState('')
  const [isBank, setIsBank] = useState(false)
  const [archived, setArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setCode(account?.code ?? '')
    setName(account?.name ?? '')
    setType(account?.type ?? 'expense')
    setGifi(account?.gifiCode ?? '')
    setIsBank(account?.isBank ?? false)
    setArchived(account?.archived ?? false)
    setError(null)
  }, [open, account])

  const typeLocked = !!account && (account.hasActivity || account.role !== null)

  async function save() {
    setSaving(true)
    try {
      await mutate('accounts.save', { id: account?.id, code, name, type, gifiCode: gifi, isBank, archived })
      fb.success(account ? 'Account updated' : 'Account added')
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
      title={account ? 'Edit account' : 'New account'}
      width="sm"
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
        <div className="grid grid-cols-[110px_1fr] gap-4">
          <Field label="Code">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} placeholder="5300" className="tabular" />}</Field>
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Type" hint={typeLocked ? 'Fixed once an account is in use.' : undefined}>
            {(id) => (
              <Select id={id} value={type} disabled={typeLocked} onChange={(e) => setType(e.target.value as AccountType)}>
                {ORDER.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="GIFI code" hint="4 digits, for the T2 return.">
            {(id) => <Input id={id} value={gifi} onChange={(e) => setGifi(e.target.value)} placeholder="e.g. 8810" className="tabular" />}
          </Field>
        </div>
        {type === 'asset' || type === 'liability' ? (
          <Checkbox label="Bank or credit card account (can receive or pay money)" checked={isBank} onChange={(e) => setIsBank(e.target.checked)} />
        ) : null}
        {account && !account.role ? <Checkbox label="Archived (hide from pickers)" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> : null}
        {account?.role ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Lock className="size-3.5" /> The app posts to this account automatically, so it can’t be archived.
          </p>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}
