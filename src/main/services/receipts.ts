/**
 * Receipt files (photos and PDFs) attached to expenses or bank transactions.
 * Stored in <app data>/receipts under a content hash; included in backups.
 * Only real images and PDFs are accepted (checked by their first bytes).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import type { Receipt } from '../../shared/types'
import { audit } from './audit'

export const MAX_RECEIPT_BYTES = 15 * 1024 * 1024

const TYPES: { mime: string; ext: string; magic: (b: Uint8Array) => boolean }[] = [
  { mime: 'application/pdf', ext: 'pdf', magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/webp', ext: 'webp', magic: (b) => b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { mime: 'image/heic', ext: 'heic', magic: (b) => new TextDecoder().decode(b.subarray(4, 12)).startsWith('ftyphei') || new TextDecoder().decode(b.subarray(4, 12)).startsWith('ftypmif') }
]

export function detectType(bytes: Uint8Array): { mime: string; ext: string } | null {
  return TYPES.find((t) => bytes.length > 12 && t.magic(bytes)) ?? null
}

interface ReceiptRow {
  id: number
  file_name: string
  mime: string
  size: number
  stored_name: string
  expense_id: number | null
  bank_transaction_id: number | null
  note: string
  created_at: string
}

const toReceipt = (r: ReceiptRow): Receipt => ({
  id: r.id,
  fileName: r.file_name,
  mime: r.mime,
  sizeBytes: r.size,
  expenseId: r.expense_id,
  bankTransactionId: r.bank_transaction_id,
  note: r.note,
  createdAt: r.created_at
})

export function addReceipt(
  db: Db,
  dir: string,
  input: { fileName: string; bytes: Uint8Array; expenseId?: number | null; bankTransactionId?: number | null; note?: string }
): Receipt {
  if (input.bytes.length === 0) throw new UserError('The file is empty.')
  if (input.bytes.length > MAX_RECEIPT_BYTES) throw new UserError('Receipts can be up to 15 MB.')
  const type = detectType(input.bytes)
  if (!type) throw new UserError('Receipts must be a photo (JPG, PNG, WEBP, HEIC) or a PDF.')
  if (input.expenseId != null && !db.get('SELECT 1 FROM expenses WHERE id = ?', input.expenseId)) throw new UserError('Expense not found.')
  if (input.bankTransactionId != null && !db.get('SELECT 1 FROM bank_transactions WHERE id = ?', input.bankTransactionId)) {
    throw new UserError('Bank transaction not found.')
  }
  const sha = createHash('sha256').update(input.bytes).digest('hex')
  const stored = `${sha}.${type.ext}`
  mkdirSync(dir, { recursive: true })
  const path = join(dir, stored)
  if (!existsSync(path)) writeFileSync(path, input.bytes)
  const safeName = input.fileName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 150) || `receipt.${type.ext}`
  const { lastInsertRowid } = db.run(
    `INSERT INTO receipts (sha256, file_name, mime, size, stored_name, expense_id, bank_transaction_id, note, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sha,
    safeName,
    type.mime,
    input.bytes.length,
    stored,
    input.expenseId ?? null,
    input.bankTransactionId ?? null,
    (input.note ?? '').slice(0, 300),
    db.actor
  )
  audit(db, 'attach', 'receipt', lastInsertRowid, safeName)
  return getReceipt(db, lastInsertRowid)
}

export function getReceipt(db: Db, id: number): Receipt {
  const r = db.get<ReceiptRow>('SELECT * FROM receipts WHERE id = ?', id)
  if (!r) throw new UserError('Receipt not found.')
  return toReceipt(r)
}

export function receiptPath(db: Db, dir: string, id: number): string {
  const r = db.get<ReceiptRow>('SELECT * FROM receipts WHERE id = ?', id)
  if (!r) throw new UserError('Receipt not found.')
  // stored_name is always <sha256>.<ext>, written by addReceipt.
  if (!/^[0-9a-f]{64}\.(pdf|jpg|png|webp|heic)$/.test(r.stored_name)) throw new UserError('Receipt file name is invalid.')
  return join(dir, r.stored_name)
}

export function listReceipts(db: Db, f: { expenseId?: number; bankTransactionId?: number } = {}): Receipt[] {
  return db
    .all<ReceiptRow>(
      `SELECT * FROM receipts WHERE (? IS NULL OR expense_id = ?) AND (? IS NULL OR bank_transaction_id = ?) ORDER BY id DESC`,
      f.expenseId ?? null,
      f.expenseId ?? null,
      f.bankTransactionId ?? null,
      f.bankTransactionId ?? null
    )
    .map(toReceipt)
}

/** All stored file names, for backups. */
export function receiptFiles(db: Db): string[] {
  return db.all<{ stored_name: string }>('SELECT DISTINCT stored_name FROM receipts').map((r) => r.stored_name)
}
