import type { Sql } from 'postgres'
import { createError } from 'nuxt/server'
import type { AuthRuntime } from './runtime.ts'
import type { PasswordResetDelivery } from '../../services/password-reset.ts'
import { PasswordResetQueue } from '../../services/password-reset-queue.ts'
import { PostgresPasswordReset } from '../../storage/postgres-password-reset.ts'

/** Server composition injects this object into event.context.passwordReset.
 * No adapter is configured by default; functions never come from runtimeConfig.
 * Composition must await runtime.close() in the application close hook before
 * closing its owned SQL pool. Delivery must honor the supplied AbortSignal.
 */
export class PasswordResetRuntime {
  readonly store: PostgresPasswordReset
  readonly auth: AuthRuntime
  readonly queue: PasswordResetQueue
  constructor(
    auth: AuthRuntime,
    sql: Sql,
    delivery: PasswordResetDelivery,
    onClose: (close: () => Promise<void>) => void,
  ) {
    this.auth = auth
    this.store = new PostgresPasswordReset(sql)
    this.queue = new PasswordResetQueue(this.store, delivery)
    // Composition passes close => nitro.hooks.hook('close', close).
    onClose(() => this.close())
  }
  close(): Promise<void> {
    return this.queue.close()
  }
}
export function createPasswordResetRuntime(
  auth: AuthRuntime,
  sql: Sql,
  onClose: (close: () => Promise<void>) => void,
  delivery?: PasswordResetDelivery,
): PasswordResetRuntime | undefined {
  return delivery
    ? new PasswordResetRuntime(auth, sql, delivery, onClose)
    : undefined
}
export function passwordResetRuntime(value: unknown): PasswordResetRuntime {
  if (!(value instanceof PasswordResetRuntime))
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  return value
}
