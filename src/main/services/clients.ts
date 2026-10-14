import type { Db } from '../db/connection'
import { UserError } from '../errors'
import type { Client } from '../../shared/types'

interface ClientRow {
  id: number
  name: string
  email: string
  phone: string
  address: string
  archived: number
  balance: number
}

// Outstanding balance = issued invoice totals minus active payments.
const SELECT = `
  SELECT c.id, c.name, c.email, c.phone, c.address, c.archived,
    COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.client_id = c.id AND i.status = 'issued'), 0)
    - COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
                WHERE i.client_id = c.id AND i.status = 'issued' AND p.void_entry_id IS NULL), 0) AS balance
  FROM clients c`

function toClient(r: ClientRow): Client {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    archived: r.archived === 1,
    balanceCents: r.balance
  }
}

export function listClients(db: Db, includeArchived = false): Client[] {
  return db
    .all<ClientRow>(`${SELECT} ${includeArchived ? '' : 'WHERE c.archived = 0'} ORDER BY c.name COLLATE NOCASE`)
    .map(toClient)
}

export function getClient(db: Db, id: number): Client {
  const r = db.get<ClientRow>(`${SELECT} WHERE c.id = ?`, id)
  if (!r) throw new UserError('Client not found.')
  return toClient(r)
}

export interface SaveClientInput {
  id?: number
  name: string
  email: string
  phone: string
  address: string
  archived?: boolean
}

export function saveClient(db: Db, input: SaveClientInput): Client {
  if (input.id === undefined) {
    const r = db.run(
      'INSERT INTO clients (name, email, phone, address) VALUES (?, ?, ?, ?)',
      input.name,
      input.email,
      input.phone,
      input.address
    )
    return getClient(db, r.lastInsertRowid)
  }
  const current = getClient(db, input.id)
  db.run(
    'UPDATE clients SET name = ?, email = ?, phone = ?, address = ?, archived = ? WHERE id = ?',
    input.name,
    input.email,
    input.phone,
    input.address,
    (input.archived ?? current.archived) ? 1 : 0,
    input.id
  )
  return getClient(db, input.id)
}
