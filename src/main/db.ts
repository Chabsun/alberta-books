/**
 * Database layer (sql.js)
 *
 * - Owns the SQLite file in Electron userData
 * - Seeds chart of accounts + settings on first run
 * - All DB access must go through this module or the IPC handlers in index.ts
 * - sql.js is pure JavaScript (no native compilation required)
 */

import initSqlJs, { Database } from 'sql.js'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

let db: Database | null = null
let dbPath: string = ''

export async function initDatabase(): Promise<void> {
  const SQL = await initSqlJs()
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  dbPath = join(userData, 'alberta-books.db')

  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
    seedDatabase(db)
  }

  // Recommended pragmas
  db.run('PRAGMA foreign_keys = ON;')
  db.run('PRAGMA journal_mode = WAL;')

  console.log('Database initialized at:', dbPath)
}

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function saveDatabase(): void {
  if (!db) return
  const data = db.export()
  const buffer = Buffer.from(data)
  writeFileSync(dbPath, buffer)
}

/**
 * Creates tables and seeds Alberta-friendly chart of accounts + default settings.
 * Called only on first launch.
 */
function seedDatabase(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset', 'liability', 'equity', 'income', 'expense')),
      parent_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      province TEXT DEFAULT 'AB',
      postal_code TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      date TEXT NOT NULL,
      due_date TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
      subtotal REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL DEFAULT 1,
      unit_price REAL DEFAULT 0,
      gst_rate REAL DEFAULT 0.05,
      line_total REAL DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT,
      reference TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)

  // Seed default chart of accounts (Alberta / Canada friendly)
  const accounts = [
    ['1000', 'Cash', 'asset'],
    ['1100', 'Accounts Receivable', 'asset'],
    ['1200', 'GST Recoverable (ITCs)', 'asset'],
    ['2000', 'Accounts Payable', 'liability'],
    ['2100', 'GST Collected', 'liability'],
    ['3000', 'Owner Equity', 'equity'],
    ['4000', 'Sales Revenue', 'income'],
    ['5000', 'Cost of Goods Sold', 'expense'],
    ['6000', 'Office Expenses', 'expense'],
    ['6100', 'Rent', 'expense'],
    ['6200', 'Utilities', 'expense'],
    ['6300', 'Professional Fees', 'expense'],
    ['6400', 'Travel', 'expense']
  ]

  const stmt = database.prepare('INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)')
  for (const [code, name, type] of accounts) {
    stmt.run([code, name, type])
  }
  stmt.free()

  // Default settings
  database.run("INSERT INTO settings (key, value) VALUES ('company_name', 'My Alberta Business')")
  database.run("INSERT INTO settings (key, value) VALUES ('gst_rate', '0.05')")
  database.run("INSERT INTO settings (key, value) VALUES ('currency', 'CAD')")
  database.run("INSERT INTO settings (key, value) VALUES ('next_invoice_number', '1001')")

  saveDatabase()
}

export function persist(): void {
  saveDatabase()
}
