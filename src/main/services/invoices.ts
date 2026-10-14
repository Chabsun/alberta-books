/**
 * Invoices.
 *
 * Life cycle: draft (editable, not in the books) -> issued (numbered, posted,
 * final) -> paid through payments, or void (reversal posted).
 *
 * Issuing posts:   Dr Accounts receivable (total)
 *                  Cr Revenue account(s)  (line amounts)
 *                  Cr GST collected       (5% of taxable lines)
 * A payment posts: Dr Bank, Cr Accounts receivable.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { todayIso } from '../../shared/dates'
import { GST_RATE_BPS, gstOn, lineAmount } from '../../shared/money'
import type { Invoice, InvoiceDisplayStatus, InvoiceLine, InvoiceStatus, InvoiceSummary, Payment } from '../../shared/types'
import { accountIdByRole, requireAccount } from './accounts'
import { getClient } from './clients'
import { postEntry, reverseEntry, type NewLine } from './ledger'
import { getSettings, updateSettings } from './settings'

export interface DraftLineInput {
  description: string
  qtyMilli: number
  unitPriceCents: number
  taxable: boolean
  accountId: number
}

export interface DraftInput {
  id?: number
  clientId: number
  issueDate: string
  dueDate: string
  notes: string
  lines: DraftLineInput[]
}

export function computeTotals(lines: Pick<DraftLineInput, 'qtyMilli' | 'unitPriceCents' | 'taxable'>[], rateBps: number) {
  const amounts = lines.map((l) => lineAmount(l.qtyMilli, l.unitPriceCents))
  const subtotal = amounts.reduce((s, a) => s + a, 0)
  const taxableBase = lines.reduce((s, l, i) => s + (l.taxable ? amounts[i] : 0), 0)
  const gst = gstOn(taxableBase, rateBps)
  return { amounts, subtotal, taxableBase, gst, total: subtotal + gst }
}

interface InvoiceRow {
  id: number
  number: string | null
  client_id: number
  client_name: string
  issue_date: string
  due_date: string
  status: InvoiceStatus
  notes: string
  gst_rate_bps: number
  subtotal: number
  gst: number
  total: number
  paid: number
  entry_id: number | null
}

const SELECT = `
  SELECT i.id, i.number, i.client_id, c.name AS client_name, i.issue_date, i.due_date, i.status,
         i.notes, i.gst_rate_bps, i.subtotal, i.gst, i.total, i.entry_id,
         COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.void_entry_id IS NULL), 0) AS paid
  FROM invoices i JOIN clients c ON c.id = i.client_id`

function displayStatus(r: InvoiceRow, today: string): InvoiceDisplayStatus {
  if (r.status === 'draft') return 'draft'
  if (r.status === 'void') return 'void'
  if (r.paid >= r.total) return 'paid'
  if (r.due_date < today) return 'overdue'
  return r.paid > 0 ? 'partial' : 'open'
}

function toSummary(r: InvoiceRow, today: string): InvoiceSummary {
  const balance = r.status === 'issued' ? r.total - r.paid : 0
  return {
    id: r.id,
    number: r.number,
    clientId: r.client_id,
    clientName: r.client_name,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    status: r.status,
    displayStatus: displayStatus(r, today),
    subtotalCents: r.subtotal,
    gstCents: r.gst,
    totalCents: r.total,
    paidCents: r.paid,
    balanceCents: balance
  }
}

export function listInvoices(db: Db): InvoiceSummary[] {
  const today = todayIso()
  return db
    .all<InvoiceRow>(`${SELECT} ORDER BY i.status = 'draft' DESC, i.issue_date DESC, i.id DESC`)
    .map((r) => toSummary(r, today))
}

export function getInvoice(db: Db, id: number): Invoice {
  const r = db.get<InvoiceRow>(`${SELECT} WHERE i.id = ?`, id)
  if (!r) throw new UserError('Invoice not found.')
  const lines = db
    .all<{
      id: number
      description: string
      qty_milli: number
      unit_price: number
      amount: number
      taxable: number
      account_id: number
    }>('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position', id)
    .map(
      (l): InvoiceLine => ({
        id: l.id,
        description: l.description,
        qtyMilli: l.qty_milli,
        unitPriceCents: l.unit_price,
        amountCents: l.amount,
        taxable: l.taxable === 1,
        accountId: l.account_id
      })
    )
  const payments = db
    .all<{ id: number; date: string; amount: number; account_id: number; account_name: string; void_entry_id: number | null }>(
      `SELECT p.id, p.date, p.amount, p.account_id, a.name AS account_name, p.void_entry_id
       FROM payments p JOIN accounts a ON a.id = p.account_id
       WHERE p.invoice_id = ? ORDER BY p.date, p.id`,
      id
    )
    .map(
      (p): Payment => ({
        id: p.id,
        invoiceId: id,
        date: p.date,
        amountCents: p.amount,
        accountId: p.account_id,
        accountName: p.account_name,
        voided: p.void_entry_id !== null
      })
    )
  return { ...toSummary(r, todayIso()), notes: r.notes, gstRateBps: r.gst_rate_bps, lines, payments }
}

export function saveDraft(db: Db, input: DraftInput): Invoice {
  const client = getClient(db, input.clientId)
  if (client.archived) throw new UserError('This client is archived.')
  for (const l of input.lines) {
    requireAccount(db, l.accountId, (a) => a.type === 'income', 'Line account')
  }
  const totals = computeTotals(input.lines, GST_RATE_BPS)
  if (totals.taxableBase < 0) throw new UserError('Taxable lines cannot add up to less than zero.')

  return db.tx(() => {
    let id = input.id
    if (id === undefined) {
      id = db.run(
        `INSERT INTO invoices (client_id, issue_date, due_date, notes, gst_rate_bps, subtotal, gst, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.clientId,
        input.issueDate,
        input.dueDate,
        input.notes,
        GST_RATE_BPS,
        totals.subtotal,
        totals.gst,
        totals.total
      ).lastInsertRowid
    } else {
      const existing = getInvoice(db, id)
      if (existing.status !== 'draft') throw new UserError('Only draft invoices can be edited.')
      db.run(
        `UPDATE invoices SET client_id = ?, issue_date = ?, due_date = ?, notes = ?, gst_rate_bps = ?,
           subtotal = ?, gst = ?, total = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        input.clientId,
        input.issueDate,
        input.dueDate,
        input.notes,
        GST_RATE_BPS,
        totals.subtotal,
        totals.gst,
        totals.total,
        id
      )
      db.run('DELETE FROM invoice_lines WHERE invoice_id = ?', id)
    }
    input.lines.forEach((l, i) => {
      db.run(
        `INSERT INTO invoice_lines (invoice_id, position, description, qty_milli, unit_price, amount, taxable, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        i,
        l.description,
        l.qtyMilli,
        l.unitPriceCents,
        totals.amounts[i],
        l.taxable ? 1 : 0,
        l.accountId
      )
    })
    return getInvoice(db, id)
  })
}

export function deleteDraft(db: Db, id: number): void {
  const inv = getInvoice(db, id)
  if (inv.status !== 'draft') throw new UserError('Only draft invoices can be deleted. Void issued invoices instead.')
  db.run('DELETE FROM invoices WHERE id = ?', id)
}

export function issueInvoice(db: Db, id: number): Invoice {
  return db.tx(() => {
    const inv = getInvoice(db, id)
    if (inv.status !== 'draft') throw new UserError('This invoice has already been issued.')
    if (inv.totalCents <= 0) throw new UserError('The invoice total must be greater than zero.')

    // Recompute from the stored lines rather than trusting stored totals.
    const totals = computeTotals(inv.lines, inv.gstRateBps)
    if (totals.total !== inv.totalCents || totals.gst !== inv.gstCents) {
      throw new Error('Invoice totals are inconsistent with its lines')
    }

    const settings = getSettings(db)
    let n = settings.nextInvoiceNumber
    let number = `${settings.invoicePrefix}${n}`
    while (db.get('SELECT 1 FROM invoices WHERE number = ?', number)) {
      n++
      number = `${settings.invoicePrefix}${n}`
    }

    // One credit per revenue account; a discount line can make an account net negative (a debit).
    const byAccount = new Map<number, number>()
    inv.lines.forEach((l, i) => byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0) + totals.amounts[i]))
    const lines: NewLine[] = [{ accountId: accountIdByRole(db, 'ar'), debit: inv.totalCents, credit: 0 }]
    for (const [accountId, amount] of byAccount) {
      lines.push({ accountId, debit: amount < 0 ? -amount : 0, credit: amount > 0 ? amount : 0 })
    }
    lines.push({ accountId: accountIdByRole(db, 'gst_collected'), debit: 0, credit: inv.gstCents })

    const entryId = postEntry(db, {
      date: inv.issueDate,
      memo: `Invoice ${number} – ${inv.clientName}`,
      source: 'invoice',
      lines
    })
    db.run(
      `UPDATE invoices SET status = 'issued', number = ?, entry_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
      number,
      entryId,
      id
    )
    updateSettings(db, { nextInvoiceNumber: n + 1 })
    return getInvoice(db, id)
  })
}

export function voidInvoice(db: Db, id: number, date: string): Invoice {
  return db.tx(() => {
    const inv = getInvoice(db, id)
    if (inv.status !== 'issued') throw new UserError('Only issued invoices can be voided.')
    if (inv.payments.some((p) => !p.voided)) throw new UserError('Void the payments on this invoice first.')
    const row = db.get<{ entry_id: number }>('SELECT entry_id FROM invoices WHERE id = ?', id)!
    const voidEntryId = reverseEntry(db, row.entry_id, date, `Void invoice ${inv.number}`)
    db.run(`UPDATE invoices SET status = 'void', void_entry_id = ? WHERE id = ?`, voidEntryId, id)
    return getInvoice(db, id)
  })
}

export interface PaymentInput {
  invoiceId: number
  date: string
  amountCents: number
  accountId: number
}

export function recordPayment(db: Db, input: PaymentInput): Invoice {
  return db.tx(() => {
    const inv = getInvoice(db, input.invoiceId)
    if (inv.status !== 'issued') throw new UserError('Payments can only be recorded on issued invoices.')
    if (input.amountCents > inv.balanceCents) {
      throw new UserError('The payment is more than the balance owing on this invoice.')
    }
    requireAccount(db, input.accountId, (a) => a.isBank && a.type === 'asset', 'Deposit account')
    const entryId = postEntry(db, {
      date: input.date,
      memo: `Payment – invoice ${inv.number} – ${inv.clientName}`,
      source: 'payment',
      lines: [
        { accountId: input.accountId, debit: input.amountCents, credit: 0 },
        { accountId: accountIdByRole(db, 'ar'), debit: 0, credit: input.amountCents }
      ]
    })
    db.run(
      'INSERT INTO payments (invoice_id, date, amount, account_id, entry_id) VALUES (?, ?, ?, ?, ?)',
      input.invoiceId,
      input.date,
      input.amountCents,
      input.accountId,
      entryId
    )
    return getInvoice(db, input.invoiceId)
  })
}

export function voidPayment(db: Db, paymentId: number, date: string): Invoice {
  return db.tx(() => {
    const p = db.get<{ invoice_id: number; entry_id: number; void_entry_id: number | null }>(
      'SELECT invoice_id, entry_id, void_entry_id FROM payments WHERE id = ?',
      paymentId
    )
    if (!p) throw new UserError('Payment not found.')
    if (p.void_entry_id !== null) throw new UserError('This payment is already void.')
    const voidEntryId = reverseEntry(db, p.entry_id, date, `Void payment #${paymentId}`)
    db.run('UPDATE payments SET void_entry_id = ? WHERE id = ?', voidEntryId, paymentId)
    return getInvoice(db, p.invoice_id)
  })
}
