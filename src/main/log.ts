import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

let logFile: string | null = null

export function initLog(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'main.log')
  try {
    if (statSync(logFile).size > 1_000_000) renameSync(logFile, `${logFile}.1`)
  } catch {
    // no log yet
  }
}

/** Writes errors to <app data>/logs/main.log. Never logs financial data, only errors. */
export function logError(context: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  const line = `${new Date().toISOString()} [${context}] ${detail}\n`
  console.error(line)
  if (!logFile) return
  try {
    appendFileSync(logFile, line)
  } catch {
    // logging must never crash the app
  }
}
