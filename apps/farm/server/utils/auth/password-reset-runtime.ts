import { createError } from 'nuxt/server'
import type { AuthRuntime } from './runtime.ts'
import type {
  PasswordResetDelivery,
  PasswordResetStore,
} from '../../services/password-reset.ts'
import type { ResetLinkStore } from '../../services/password-reset-links.ts'
import { PasswordResetQueue } from '../../services/password-reset-queue.ts'

/** The password-reset plugin injects this object into event.context.passwordReset
 * only when reset is enabled. Owner-issued links need no delivery. A self-service
 * request queue exists only with a trusted delivery; none is configured by default,
 * so the request endpoint answers 404 and cannot replace an owner-issued link.
 */
export class PasswordResetRuntime {
  readonly store: PasswordResetStore & ResetLinkStore
  readonly auth: AuthRuntime
  readonly queue: PasswordResetQueue | undefined
  constructor(
    auth: AuthRuntime,
    store: PasswordResetStore & ResetLinkStore,
    delivery?: PasswordResetDelivery,
  ) {
    this.auth = auth
    this.store = store
    this.queue = delivery ? new PasswordResetQueue(store, delivery) : undefined
  }
  /** Await in the application close hook before closing the owned SQL pool. */
  async close(): Promise<void> {
    await this.queue?.close()
  }
}
export function passwordResetRuntime(value: unknown): PasswordResetRuntime {
  if (!(value instanceof PasswordResetRuntime))
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  return value
}
