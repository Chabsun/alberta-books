/**
 * Backups. A backup is a complete, consistent copy of the database made with
 * SQLite's VACUUM INTO (safe to run while the app is open).
 *
 * Automatic backups go to <app data>/backups and the newest 60 are kept.
 * An optional second folder (e.g. iCloud Drive or Dropbox) gets a copy too,
 * so the books survive the loss of the computer.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from '../db/connection'
import { APPLICATION_ID, SCHEMA_VERSION } from '../db/migrations'
import type { BackupInfo } from '../../shared/types'

const PREFIX = 'alberta-books-'
const NAME_RE = /^alberta-books-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.db$/
export const KEEP_BACKUPS = 60

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Writes a backup into `dir` and returns its full path. */
export function backupTo(db: Db, dir: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true })
  let path = join(dir, `${PREFIX}${stamp(now)}.db`)
  for (let i = 1; existsQuiet(path); i++) path = join(dir, `${PREFIX}${stamp(now)}-${i}.db`)
  db.raw.prepare('VACUUM INTO ?').run(path)
  return path
}

function existsQuiet(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function listBackups(dir: string): BackupInfo[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => NAME_RE.test(n))
    .map((name) => {
      const st = statSync(join(dir, name))
      return { name, createdAt: st.mtime.toISOString(), sizeBytes: st.size }
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}

/** Deletes the oldest backups beyond `keep`. Only touches files this app created. */
export function pruneBackups(dir: string, keep = KEEP_BACKUPS): void {
  for (const b of listBackups(dir).slice(keep)) unlinkSync(join(dir, b.name))
}

/**
 * Checks that a file is a healthy Alberta Books database this version can open.
 * Throws an Error with a user-readable message otherwise.
 */
export function validateDatabaseFile(path: string): void {
  let probe: DatabaseSync
  try {
    probe = new DatabaseSync(path, { readOnly: true })
  } catch {
    throw new Error('That file could not be opened as a database.')
  }
  try {
    const appId = Number((probe.prepare('PRAGMA application_id').get() as { application_id: number }).application_id)
    if (appId !== APPLICATION_ID) throw new Error('That file is not an Alberta Books backup.')
    const version = Number((probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version > SCHEMA_VERSION) throw new Error('That backup was made by a newer version of the app.')
    const check = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') throw new Error('That backup is damaged and cannot be restored.')
  } catch (err) {
    if (err instanceof Error && /backup|database|file/i.test(err.message)) throw err
    throw new Error('That file could not be read as an Alberta Books backup.')
  } finally {
    probe.close()
  }
}
