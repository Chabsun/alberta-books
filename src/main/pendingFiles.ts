/**
 * Files the user picked (or dropped) and is still reviewing: a statement whose
 * columns are being checked, or a history export being mapped. The UI only
 * holds a random token; the bytes stay in the main process for 30 minutes.
 */
import { randomBytes } from 'node:crypto'
import { UserError } from './errors'

export type PendingKind = 'statement' | 'migration'

interface Pending {
  kind: PendingKind
  fileName: string
  bytes: Uint8Array
  expires: number
}

const TTL_MS = 30 * 60_000
const MAX_FILES = 6
const files = new Map<string, Pending>()

function sweep(now = Date.now()): void {
  for (const [k, v] of files) if (v.expires < now) files.delete(k)
  while (files.size >= MAX_FILES) files.delete(files.keys().next().value!)
}

export function holdFile(kind: PendingKind, fileName: string, bytes: Uint8Array): string {
  sweep()
  const token = randomBytes(18).toString('base64url')
  files.set(token, { kind, fileName, bytes, expires: Date.now() + TTL_MS })
  return token
}

export function takeFile(kind: PendingKind, token: string): { fileName: string; bytes: Uint8Array } {
  const f = files.get(token)
  if (!f || f.kind !== kind || f.expires < Date.now()) throw new UserError('That file is no longer open. Choose it again.')
  return { fileName: f.fileName, bytes: f.bytes }
}

export function releaseFile(token: string): void {
  files.delete(token)
}
