import { Scrypt } from '@adonisjs/hash/drivers/scrypt'

// Explicit cost and memory budget. At most two concurrent derivations per worker.
const scrypt = new Scrypt({
  cost: 131072,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 160 * 1024 * 1024,
  saltSize: 16,
  keyLength: 64,
})
let active = 0
export class PasswordCapacityError extends Error {}
async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  if (active >= 2)
    throw new PasswordCapacityError('Password capacity exhausted')
  active++
  try {
    return await operation()
  } finally {
    active--
  }
}
export function hashPassword(password: string): Promise<string> {
  return bounded(() => scrypt.make(password))
}
export function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  return bounded(() => scrypt.verify(hash, password))
}
// A fixed syntactically valid synthetic hash makes unknown-user checks run scrypt too.
export const DUMMY_PASSWORD_HASH =
  '$scrypt$n=131072,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
