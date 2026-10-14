/**
 * App-wide state for the main process: the open database and where files live.
 * The database handle is replaced when a backup is restored.
 */
import { copyFileSync, renameSync, rmSync } from 'node:fs'
import { Db } from './db/connection'
import { backupTo, listBackups, pruneBackups, validateDatabaseFile } from './services/backup'
import { getSettings } from './services/settings'
import { logError } from './log'

export class AppContext {
  db: Db
  private changesAtLastBackup = 0

  constructor(
    readonly dbPath: string,
    readonly autoBackupDir: string
  ) {
    this.db = new Db(dbPath)
  }

  private totalChanges(): number {
    return Number(this.db.get<{ n: number }>('SELECT total_changes() AS n')!.n)
  }

  lastBackupAt(): string | null {
    return listBackups(this.autoBackupDir)[0]?.createdAt ?? null
  }

  /** Backs up to the automatic folder and, if set, the extra folder. Returns the automatic copy's path. */
  backup(): string {
    const path = backupTo(this.db, this.autoBackupDir)
    pruneBackups(this.autoBackupDir)
    const extra = getSettings(this.db).backupDir
    if (extra) {
      try {
        backupTo(this.db, extra)
        pruneBackups(extra)
      } catch (err) {
        // The extra folder may be on a disconnected drive; the automatic backup still succeeded.
        logError('backup:extra', err)
      }
    }
    this.changesAtLastBackup = this.totalChanges()
    return path
  }

  /** Backs up when the newest automatic backup is older than `hours`. */
  backupIfOlderThan(hours: number): void {
    const last = this.lastBackupAt()
    if (last === null || Date.now() - Date.parse(last) > hours * 3_600_000) this.backup()
  }

  backupIfChanged(): void {
    if (this.totalChanges() !== this.changesAtLastBackup) this.backup()
  }

  /**
   * Replaces the books with a backup file. The current books are backed up
   * first, so a restore can always be undone by restoring that copy.
   */
  restoreFrom(sourcePath: string): void {
    // Copy next to the live file first, check the copy, then swap it in with an
    // atomic rename: an interrupted restore can never leave a half-written file.
    const staged = `${this.dbPath}.restoring`
    copyFileSync(sourcePath, staged)
    try {
      validateDatabaseFile(staged)
    } catch (err) {
      rmSync(staged, { force: true })
      throw err
    }
    this.backup()
    this.db.close()
    try {
      for (const suffix of ['-wal', '-shm']) rmSync(this.dbPath + suffix, { force: true })
      renameSync(staged, this.dbPath)
    } finally {
      this.db = new Db(this.dbPath)
      this.changesAtLastBackup = this.totalChanges()
    }
  }

  close(): void {
    this.db.close()
  }
}
