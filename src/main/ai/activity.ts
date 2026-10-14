/**
 * What AI assistants did, from the audit log, with a one-click undo for each
 * change. Undo never deletes history: it posts a reversal or a void, exactly
 * as you would from the app.
 */
import type { Db } from '../db/connection'
import { UserError } from '../errors'
import { todayIso } from '../../shared/dates'
import type { AiActivity, AuditEvent } from '../../shared/types'
import { listAudit } from '../services/audit'
import { deleteRule, uncategorize } from '../services/bankFeed'
import { voidExpense } from '../services/expenses'
import { reverseManualEntry } from '../services/ledger'
import { deleteTrip } from '../services/vehicles'


function canUndo(db: Db, e: AuditEvent): boolean {
  if (e.entityId === null) return false
  switch (`${e.entity}:${e.action}`) {
    case 'expense:create':
      return !!db.get('SELECT 1 FROM expenses WHERE id = ? AND void_entry_id IS NULL', e.entityId)
    case 'bank_transaction:categorize':
      return !!db.get(`SELECT 1 FROM bank_transactions WHERE id = ? AND status = 'posted' AND entry_id IS ?`, e.entityId, e.entryId)
    case 'journal_entry:post':
      return !!db.get(
        `SELECT 1 FROM journal_entries e WHERE e.id = ? AND e.source = 'manual' AND e.posted = 1
           AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id AND r.posted = 1)`,
        e.entityId
      )
    case 'bank_rule:create':
      return !!db.get('SELECT 1 FROM bank_rules WHERE id = ?', e.entityId)
    case 'vehicle_trip:create':
      return !!db.get('SELECT 1 FROM vehicle_trips WHERE id = ?', e.entityId)
    default:
      return false
  }
}

export function listAiActivity(db: Db, limit = 300): AiActivity[] {
  return listAudit(db, { actorPrefix: 'ai:', limit }).map((e) => ({ ...e, canUndo: canUndo(db, e) }))
}

/** Undoes one assistant change. Runs as you ("user"), so the undo is yours in the audit log. */
export function undoAiActivity(db: Db, auditId: number): void {
  const e = listAudit(db, { actorPrefix: 'ai:', limit: 100_000 }).find((x) => x.id === auditId)
  if (!e) throw new UserError('That activity was not found.')
  if (!canUndo(db, e)) throw new UserError('This change has already been undone or cannot be undone.')
  const id = e.entityId!
  switch (`${e.entity}:${e.action}`) {
    case 'expense:create':
      voidExpense(db, id, todayIso())
      break
    case 'bank_transaction:categorize':
      uncategorize(db, id, todayIso())
      break
    case 'journal_entry:post':
      reverseManualEntry(db, id, todayIso())
      break
    case 'bank_rule:create':
      deleteRule(db, id)
      break
    case 'vehicle_trip:create':
      deleteTrip(db, id)
      break
  }
}
