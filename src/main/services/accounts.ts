import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { TAX_RULES, type TaxRuleId } from '../../shared/taxRules'
import { audit } from './audit'
import type { Account, AccountRole, AccountType } from '../../shared/types'

interface AccountRow {
  id: number
  code: string
  name: string
  type: AccountType
  gifi_code: string | null
  role: AccountRole | null
  is_bank: number
  archived: number
  tax_rule: string | null
  debit: number
  credit: number
  line_count: number
}

export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense'
}

/** Balance in the account's normal direction. */
export function normalBalance(type: AccountType, debit: number, credit: number): number {
  return isDebitNormal(type) ? debit - credit : credit - debit
}

const SELECT = `
  SELECT a.id, a.code, a.name, a.type, a.gifi_code, a.role, a.is_bank, a.archived, a.tax_rule,
         COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit,
         COUNT(l.id) AS line_count
  FROM accounts a
  LEFT JOIN ledger l ON l.account_id = a.id`

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    gifiCode: r.gifi_code,
    role: r.role,
    isBank: r.is_bank === 1,
    archived: r.archived === 1,
    taxRule: r.tax_rule,
    balanceCents: normalBalance(r.type, r.debit, r.credit),
    hasActivity: r.line_count > 0
  }
}

export function listAccounts(db: Db, includeArchived = false): Account[] {
  const rows = db.all<AccountRow>(
    `${SELECT} ${includeArchived ? '' : 'WHERE a.archived = 0'} GROUP BY a.id ORDER BY a.code`
  )
  return rows.map(toAccount)
}

export function getAccount(db: Db, id: number): Account {
  const row = db.get<AccountRow>(`${SELECT} WHERE a.id = ? GROUP BY a.id`, id)
  if (!row) throw new UserError('Account not found.')
  return toAccount(row)
}

export function accountIdByRole(db: Db, role: AccountRole): number {
  const row = db.get<{ id: number }>('SELECT id FROM accounts WHERE role = ?', role)
  if (!row) throw new Error(`System account missing for role ${role}`)
  return row.id
}

/** Loads an active account and checks `allowed(account)`. */
export function requireAccount(db: Db, id: number, allowed: (a: Account) => boolean, label: string): Account {
  const a = getAccount(db, id)
  if (a.archived) throw new UserError(`${label}: "${a.name}" is archived.`)
  if (!allowed(a)) throw new UserError(`${label}: "${a.name}" cannot be used here.`)
  return a
}

export interface SaveAccountInput {
  id?: number
  code: string
  name: string
  type: string
  gifiCode?: string
  isBank?: boolean
  archived?: boolean
  /** CRA rule for expense accounts and capital asset accounts. */
  taxRule?: string | null
}

/** Checks a CRA rule fits the account type; returns the rule to store. */
function ruleFor(type: AccountType, isBank: boolean, requested: string | null | undefined): string | null {
  if (type === 'expense') {
    const id = requested ?? 'standard'
    const rule = TAX_RULES[id as TaxRuleId]
    if (!rule) throw new UserError('Unknown CRA rule.')
    if (rule.ccaClass) throw new UserError('Capital asset rules belong on asset accounts, not expense accounts.')
    return id
  }
  if (type === 'asset' && !isBank && requested) {
    const rule = TAX_RULES[requested as TaxRuleId]
    if (!rule?.ccaClass) throw new UserError('Asset accounts can only use a capital asset (CCA) rule.')
    return requested
  }
  return null
}

export function saveAccount(db: Db, input: SaveAccountInput): Account {
  const type = input.type as AccountType
  const gifi = input.gifiCode ? input.gifiCode : null
  const isBank = input.isBank ? 1 : 0
  if (isBank && type !== 'asset' && type !== 'liability') {
    throw new UserError('Only asset or liability accounts can be bank or credit card accounts.')
  }

  return db.tx(() => {
    if (input.id === undefined) {
      const r = db.run(
        'INSERT INTO accounts (code, name, type, gifi_code, is_bank, tax_rule) VALUES (?, ?, ?, ?, ?, ?)',
        input.code,
        input.name,
        type,
        gifi,
        isBank,
        ruleFor(type, isBank === 1, input.taxRule)
      )
      audit(db, 'create', 'account', r.lastInsertRowid, `${input.code} ${input.name}`)
      return getAccount(db, r.lastInsertRowid)
    }

    const current = getAccount(db, input.id)
    if (current.type !== type && (current.hasActivity || current.role)) {
      throw new UserError('The type of an account that has transactions (or is used by the app) cannot change.')
    }
    const archived = input.archived ?? current.archived
    if (archived && !current.archived) {
      if (current.role) throw new UserError('This account is used by the app and cannot be archived.')
      if (current.balanceCents !== 0) throw new UserError('Only accounts with a zero balance can be archived.')
    }
    if (current.role === 'bank' && !isBank) {
      throw new UserError('The main bank account must stay a bank account.')
    }
    db.run(
      'UPDATE accounts SET code = ?, name = ?, type = ?, gifi_code = ?, is_bank = ?, archived = ?, tax_rule = ? WHERE id = ?',
      input.code,
      input.name,
      type,
      gifi,
      isBank,
      archived ? 1 : 0,
      ruleFor(type, isBank === 1, input.taxRule === undefined ? current.taxRule : input.taxRule),
      input.id
    )
    audit(db, 'update', 'account', input.id, `${input.code} ${input.name}`)
    return getAccount(db, input.id)
  })
}
