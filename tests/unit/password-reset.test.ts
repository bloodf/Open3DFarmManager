import { test, expect, vi } from 'vitest'
import {
  completePasswordReset,
  requestPasswordReset,
  resetTokenDigest,
  type PasswordResetStore,
} from '../../apps/farm/server/services/password-reset.ts'

test('delivery receives a random token while storage receives only its digest', async () => {
  const issue = vi.fn(async (_username: string, _digest: string) => true)
  const deliver = vi.fn(async (_username: string, _token: string) => {})
  const store: PasswordResetStore = { issue, consume: vi.fn() }
  await requestPasswordReset('alice', store, { deliver })
  const token = deliver.mock.calls[0]?.[1]
  expect(typeof token).toBe('string')
  if (typeof token !== 'string') throw new Error('Missing token')
  expect(issue).toHaveBeenCalledWith('alice', resetTokenDigest(token))
  expect(issue.mock.calls[0]).not.toContain(token)
})
test('unknown accounts do not receive delivery', async () => {
  const deliver = vi.fn()
  await requestPasswordReset(
    'alice',
    { issue: async () => false, consume: vi.fn() },
    { deliver },
  )
  expect(deliver).not.toHaveBeenCalled()
})
test('completion binds account and token and preserves storage rejection', async () => {
  const consume = vi.fn(async () => false)
  const hash = vi.fn(async () => 'synthetic-hash')
  const token = 'A'.repeat(43)
  expect(
    await completePasswordReset(
      { username: 'alice', token, password: 'new password' },
      { issue: vi.fn(), consume },
      hash,
    ),
  ).toBe(false)
  expect(consume).toHaveBeenCalledWith(
    'alice',
    resetTokenDigest(token),
    'synthetic-hash',
  )
})
test.each(['', 'bad\0password', 'x'.repeat(1025)])(
  'invalid password never reaches KDF or storage',
  async (password) => {
    const hash = vi.fn()
    const consume = vi.fn()
    expect(
      await completePasswordReset(
        { username: 'alice', token: 'A'.repeat(43), password },
        { issue: vi.fn(), consume },
        hash,
      ),
    ).toBe(false)
    expect(hash).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  },
)
