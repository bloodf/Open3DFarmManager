import { createHash, randomBytes } from 'node:crypto'
import { hashPassword } from '../utils/auth/password.ts'

export interface PasswordResetStore {
  issue(username: string, digest: string): Promise<boolean>
  consume(
    username: string,
    digest: string,
    passwordHash: string,
  ): Promise<boolean>
}
/** Trusted delivery resolves its destination independently; never accept a destination from the request. */
export interface PasswordResetDelivery {
  deliver(username: string, token: string, signal: AbortSignal): Promise<void>
}
export function resetTokenDigest(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid reset token')
  return createHash('sha256').update(token).digest('hex')
}
export async function requestPasswordReset(
  username: string,
  store: PasswordResetStore,
  delivery: PasswordResetDelivery,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  if (!/^[a-z0-9_-]{3,64}$/.test(username)) throw new Error('Invalid username')
  if (signal.aborted) return
  const token = randomBytes(32).toString('base64url')
  if (await store.issue(username, resetTokenDigest(token))) {
    if (!signal.aborted) await delivery.deliver(username, token, signal)
  }
}
export async function completePasswordReset(
  input: { username: string; token: string; password: string },
  store: PasswordResetStore,
  hash: typeof hashPassword = hashPassword,
): Promise<boolean> {
  if (
    !/^[a-z0-9_-]{3,64}$/.test(input.username) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
    !input.password.length ||
    input.password.includes('\0') ||
    Buffer.byteLength(input.password) > 1024
  )
    return false
  return store.consume(
    input.username,
    resetTokenDigest(input.token),
    await hash(input.password),
  )
}
