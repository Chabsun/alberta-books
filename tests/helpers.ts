import { Db } from '../src/main/db/connection'
import { accountIdByRole, listAccounts } from '../src/main/services/accounts'
import { saveClient } from '../src/main/services/clients'
import { issueInvoice, saveDraft } from '../src/main/services/invoices'

export function makeDb(): Db {
  return new Db(':memory:')
}

export function acct(db: Db, code: string): number {
  const a = listAccounts(db, true).find((x) => x.code === code)
  if (!a) throw new Error(`no account ${code}`)
  return a.id
}

export function role(db: Db, r: Parameters<typeof accountIdByRole>[1]): number {
  return accountIdByRole(db, r)
}

export function client(db: Db, name = 'Acme Energy Ltd.'): number {
  return saveClient(db, { name, email: '', phone: '', address: '' }).id
}

/** Creates and issues an invoice with one taxable line of `cents` at qty 1. */
export function issued(db: Db, cents: number, date = '2026-03-10', clientId = client(db)) {
  const d = saveDraft(db, {
    clientId,
    issueDate: date,
    dueDate: date,
    notes: '',
    lines: [{ description: 'Consulting', qtyMilli: 1000, unitPriceCents: cents, taxable: true, accountId: role(db, 'sales') }]
  })
  return issueInvoice(db, d.id)
}

export function balanceOf(db: Db, id: number): number {
  return listAccounts(db, true).find((a) => a.id === id)!.balanceCents
}
