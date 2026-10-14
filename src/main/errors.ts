import { USER_ERROR_PREFIX } from './db/migrations'

/** An error whose message is safe and useful to show to the user. */
export class UserError extends Error {}

/** Message to show for any error; internal details are logged, not shown. */
export function userMessage(err: unknown): string | null {
  if (err instanceof UserError) return err.message
  if (err instanceof Error) {
    const i = err.message.indexOf(USER_ERROR_PREFIX)
    if (i >= 0) return err.message.slice(i + USER_ERROR_PREFIX.length)
    if (/UNIQUE constraint failed: accounts\.code/.test(err.message)) return 'That account code is already in use.'
  }
  return null
}
