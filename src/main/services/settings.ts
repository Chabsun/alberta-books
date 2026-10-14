import type { Db } from '../db/connection'
import type { Settings } from '../../shared/types'

const DEFAULTS: Settings = {
  companyName: 'My Corporation Ltd.',
  address: '',
  email: '',
  phone: '',
  gstNumber: '',
  fiscalYearEndMonth: 12,
  invoicePrefix: 'INV-',
  nextInvoiceNumber: 1001,
  paymentTermsDays: 30,
  invoiceFooter: 'Thank you for your business.',
  lockDate: null,
  backupDir: null
}

/** Settings keys as stored in the database (lock_date is read by a trigger). */
const KEYS: Record<keyof Settings, string> = {
  companyName: 'company_name',
  address: 'address',
  email: 'email',
  phone: 'phone',
  gstNumber: 'gst_number',
  fiscalYearEndMonth: 'fiscal_year_end_month',
  invoicePrefix: 'invoice_prefix',
  nextInvoiceNumber: 'next_invoice_number',
  paymentTermsDays: 'payment_terms_days',
  invoiceFooter: 'invoice_footer',
  lockDate: 'lock_date',
  backupDir: 'backup_dir'
}

const NUMERIC = new Set<keyof Settings>(['fiscalYearEndMonth', 'nextInvoiceNumber', 'paymentTermsDays'])

export function getSettings(db: Db): Settings {
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
  const stored = new Map(rows.map((r) => [r.key, r.value]))
  const out = { ...DEFAULTS } as Record<keyof Settings, unknown>
  for (const [field, key] of Object.entries(KEYS) as [keyof Settings, string][]) {
    const v = stored.get(key)
    if (v === undefined) continue
    out[field] = NUMERIC.has(field) ? Number(v) : v
  }
  return out as unknown as Settings
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  db.tx(() => {
    for (const [field, value] of Object.entries(patch) as [keyof Settings, unknown][]) {
      if (value === undefined) continue
      const key = KEYS[field]
      if (value === null) db.run('DELETE FROM settings WHERE key = ?', key)
      else
        db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          String(value)
        )
    }
  })
  return getSettings(db)
}
