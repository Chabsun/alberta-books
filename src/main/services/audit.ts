/**
 * Append-only audit log: who (you, an import, or an AI assistant) did what.
 * The database refuses edits and deletes of these rows.
 */
import type { Db } from '../db/connection'

export interface AuditEvent {
  id: number
  at: string
  actor: string
  action: string
  entity: string
  entityId: number | null
  summary: string
  entryId: number | null
}

export function audit(
  db: Db,
  action: string,
  entity: string,
  entityId: number | null,
  summary: string,
  entryId: number | null = null
): void {
  db.run(
    'INSERT INTO audit_log (actor, action, entity, entity_id, summary, entry_id) VALUES (?, ?, ?, ?, ?, ?)',
    db.actor,
    action,
    entity,
    entityId,
    summary.slice(0, 500),
    entryId
  )
}

export function listAudit(db: Db, opts: { actorPrefix?: string; limit?: number } = {}): AuditEvent[] {
  const rows = db.all<{
    id: number
    at: string
    actor: string
    action: string
    entity: string
    entity_id: number | null
    summary: string
    entry_id: number | null
  }>(
    `SELECT * FROM audit_log WHERE (? IS NULL OR actor LIKE ? || '%') ORDER BY id DESC LIMIT ?`,
    opts.actorPrefix ?? null,
    opts.actorPrefix ?? null,
    opts.limit ?? 200
  )
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    summary: r.summary,
    entryId: r.entry_id
  }))
}
