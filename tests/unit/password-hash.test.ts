import { describe, expect, test } from 'bun:test'
import {
  DUMMY_PASSWORD_HASH,
  PasswordCapacityError,
  hashPassword,
  verifyPassword,
} from '../../apps/farm/server/utils/auth/password.ts'

// Synthetic precomputed PHC vector from @adonisjs/hash v9.1.1's scrypt tests.
const legacyHash =
  '$scrypt$n=16384,r=8,p=1$YhdCGu1G+vTC6F9oJZ16lg$' +
  'IDWTbizFCq5n9YvPiy3YTPdUD12Nf1Iit8aQeGyWZdA9k9L8rKk9Ii5jQxSkV0MJyxr3/nzOHh+VTht0KFxiBA'

describe('password hash upgrade compatibility', () => {
  test('verifies legacy PHC without changing its encoded parameters', async () => {
    expect(await verifyPassword(legacyHash, 'password')).toBe(true)
    expect(await verifyPassword(legacyHash, 'Password')).toBe(false)
    expect(await verifyPassword(legacyHash, 'password\0')).toBe(false)
  })

  test('keeps explicit production cost, salt size and key length', async () => {
    const password = 'synthetic-upgrade-password-á'
    const first = await hashPassword(password)
    const second = await hashPassword(password)
    expect(first).toMatch(/^\$scrypt\$n=131072,r=8,p=1\$/)
    expect(Buffer.from(first.split('$')[3]!, 'base64')).toHaveLength(16)
    expect(Buffer.from(first.split('$')[4]!, 'base64')).toHaveLength(64)
    expect(first).not.toBe(second)
    expect(await verifyPassword(first, password)).toBe(true)
    expect(await verifyPassword(first, password + 'x')).toBe(false)
    expect(await verifyPassword(first, password.toUpperCase())).toBe(false)
  })

  test('rejects malformed hashes and other algorithms', async () => {
    for (const hash of [
      '',
      'password',
      legacyHash.replace('$scrypt$', '$argon2id$'),
      legacyHash.replace('n=16384,', ''),
      legacyHash.replace('n=16384', 'n=0'),
      legacyHash.slice(0, -20),
    ]) {
      expect(await verifyPassword(hash, 'password')).toBe(false)
    }
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, 'password')).toBe(false)
  })

  test('rejects a third derivation and releases capacity after completion', async () => {
    const first = verifyPassword(DUMMY_PASSWORD_HASH, 'synthetic-first')
    const second = verifyPassword(DUMMY_PASSWORD_HASH, 'synthetic-second')
    try {
      await expect(hashPassword('synthetic-third')).rejects.toBeInstanceOf(
        PasswordCapacityError,
      )
    } finally {
      expect(await Promise.all([first, second])).toEqual([false, false])
    }
    expect(await verifyPassword(legacyHash, 'password')).toBe(true)
  })
})
