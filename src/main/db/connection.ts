/**
 * SQLite connection (Node's built-in node:sqlite: the real SQLite engine,
 * writing to a real file, with no native module to compile).
 *
 * Durability settings:
 *  - WAL journal: a crash mid-write cannot corrupt the database.
 *  - synchronous=FULL: a committed transaction survives a power cut.
 *  - foreign_keys=ON: rows can never point at missing rows.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { migrate } from './migrations'

export type Row = Record<string, SQLInputValue>

export class Db {
  readonly raw: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()
  private depth = 0
  /** Who is making changes: 'user', 'import', 'system' or 'ai:<connection name>'. Recorded in the audit log. */
  actor = 'user'

  /** Runs `fn` with changes attributed to `actor` (services are synchronous, so this cannot interleave). */
  as<T>(actor: string, fn: () => T): T {
    const previous = this.actor
    this.actor = actor
    try {
      return fn()
    } finally {
      this.actor = previous
    }
  }

  constructor(path: string) {
    this.raw = new DatabaseSync(path)
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `)
    migrate(this)
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[]
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params)
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  /**
   * Runs `fn` atomically: either every write inside it is saved or none is.
   * Nested calls use savepoints, so services can safely call each other.
   */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth}`
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE')
    else this.raw.exec(`SAVEPOINT ${name}`)
    this.depth++
    try {
      const result = fn()
      this.depth--
      if (this.depth === 0) this.raw.exec('COMMIT')
      else this.raw.exec(`RELEASE ${name}`)
      return result
    } catch (err) {
      this.depth--
      if (this.depth === 0) this.raw.exec('ROLLBACK')
      else this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
      throw err
    }
  }

  close(): void {
    this.cache.clear()
    if (this.raw.isOpen) this.raw.close()
  }
}
