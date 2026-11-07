import type { Sql } from 'postgres'
import { createError } from 'nuxt/server'
import type { AuthRuntime } from './runtime.ts'
import type { PasswordResetDelivery } from '../../services/password-reset.ts'
import { PostgresPasswordReset } from '../../storage/postgres-password-reset.ts'

/** Server composition injects this object into event.context.passwordReset.
 * No adapter is configured by default; functions never come from runtimeConfig.
 * The caller owns the SQL pool and closes it with its application lifecycle.
 */
export class PasswordResetRuntime {
  readonly store: PostgresPasswordReset
  readonly auth: AuthRuntime
  readonly delivery: PasswordResetDelivery
  constructor(auth: AuthRuntime, sql: Sql, delivery: PasswordResetDelivery) {
    this.auth = auth
    this.delivery = delivery
    this.store = new PostgresPasswordReset(sql)
  }
}
export function createPasswordResetRuntime(
  auth: AuthRuntime,
  sql: Sql,
  delivery?: PasswordResetDelivery,
): PasswordResetRuntime | undefined {
  return delivery ? new PasswordResetRuntime(auth, sql, delivery) : undefined
}
export function passwordResetRuntime(value: unknown): PasswordResetRuntime {
  if (!(value instanceof PasswordResetRuntime))
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  return value
}
