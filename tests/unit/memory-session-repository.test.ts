import { expect, test } from 'bun:test'
import { MemorySessionRepository } from '../helpers/memory-session-repository.ts'
const account = { id: 'account-one', sessionVersion: 2, disabled: false }
const session = {
  id: 'session-one',
  accountId: account.id,
  accountVersion: 2,
  createdAt: 100,
  lastSeenAt: 200,
  absoluteExpiresAt: 1000,
  revokedAt: null,
}
const second = { ...session, id: 'session-two' }
const unrelatedAccount = { ...account, id: 'account-other' }
const unrelatedSession = {
  ...session,
  id: 'session-other',
  accountId: unrelatedAccount.id,
}
const policy = { idleTimeoutMs: 300 }
const store = () =>
  new MemorySessionRepository(
    [account, unrelatedAccount],
    [session, second, unrelatedSession],
  )

test('touch updates only activity and leaves absolute expiration unchanged', async () => {
  const db = store()
  expect((await db.authorizeAndTouch(session.id, 499, policy)).ok).toBe(true)
  expect((await db.authorizeAndTouch(session.id, 798, policy)).ok).toBe(true)
  expect(db.sessionForTest(session.id)).toEqual({ ...session, lastSeenAt: 798 })
  expect(await db.authorizeAndTouch(session.id, 1000, policy)).toEqual({
    ok: false,
    reason: 'expired',
  })
  expect(db.sessionForTest(session.id)?.lastSeenAt).toBe(798)
})
test('single logout is idempotent, preserves first revocation and leaves sibling sessions active', async () => {
  const db = store()
  await db.revokeSession(session.id, 300)
  await db.revokeSession(session.id, 301)
  await db.revokeSession('absent', 301)
  expect(db.sessionForTest(session.id)?.revokedAt).toBe(300)
  expect(await db.authorizeAndTouch(session.id, 301, policy)).toEqual({
    ok: false,
    reason: 'revoked',
  })
  expect((await db.authorizeAndTouch(second.id, 301, policy)).ok).toBe(true)
})
test('account invalidation rejects every old session without affecting another account', async () => {
  const db = store()
  await db.revokeAccountSessions(account.id)
  await db.revokeAccountSessions(account.id)
  expect(db.accountForTest(account.id)?.sessionVersion).toBe(4)
  for (const id of [session.id, second.id])
    expect(await db.authorizeAndTouch(id, 300, policy)).toEqual({
      ok: false,
      reason: 'revoked',
    })
  expect(
    (await db.authorizeAndTouch(unrelatedSession.id, 300, policy)).ok,
  ).toBe(true)
})
test('same-turn revoke before authorization rejects; authorization before revoke cannot resurrect state', async () => {
  const first = store()
  const [, decision] = await Promise.all([
    first.revokeSession(session.id, 300),
    first.authorizeAndTouch(session.id, 300, policy),
  ])
  expect(decision).toEqual({ ok: false, reason: 'revoked' })
  const second = store()
  const [prior] = await Promise.all([
    second.authorizeAndTouch(session.id, 300, policy),
    second.revokeSession(session.id, 300),
  ])
  expect(prior.ok).toBe(true)
  expect(await second.authorizeAndTouch(session.id, 300, policy)).toEqual({
    ok: false,
    reason: 'revoked',
  })
})
test('same-turn account invalidation takes effect before subsequent authorization', async () => {
  const db = store()
  const [, decision] = await Promise.all([
    db.revokeAccountSessions(account.id),
    db.authorizeAndTouch(session.id, 300, policy),
  ])
  expect(decision).toEqual({ ok: false, reason: 'revoked' })
})
test('storage failure denies authorization and rejects revocation without mutating state', async () => {
  const db = store()
  db.setAvailableForTest(false)
  expect(await db.authorizeAndTouch(session.id, 300, policy)).toEqual({
    ok: false,
    reason: 'storage-unavailable',
  })
  await expect(db.revokeSession(session.id, 300)).rejects.toThrow(
    'Session storage unavailable',
  )
  await expect(db.revokeAccountSessions(account.id)).rejects.toThrow(
    'Session storage unavailable',
  )
  expect(db.sessionForTest(session.id)).toEqual(session)
  expect(db.accountForTest(account.id)).toEqual(account)
  db.setAvailableForTest(true)
  expect((await db.authorizeAndTouch(session.id, 300, policy)).ok).toBe(true)
})
test('clock rollback cannot revive an expired session or overwrite newer activity', async () => {
  const db = store()
  expect(await db.authorizeAndTouch(session.id, 500, policy)).toEqual({
    ok: false,
    reason: 'expired',
  })
  expect(await db.authorizeAndTouch(session.id, 300, policy)).toEqual({
    ok: false,
    reason: 'invalid-state',
  })
  await expect(db.revokeSession(session.id, 300)).rejects.toThrow(
    'Invalid revocation request',
  )
  expect(db.sessionForTest(session.id)).toEqual(session)
})
test('fixtures and inspection results cannot mutate stored session or revocation state', async () => {
  const seedAccount = { ...account },
    seedSession = { ...session }
  const db = new MemorySessionRepository([seedAccount], [seedSession])
  seedAccount.sessionVersion = 99
  seedSession.lastSeenAt = 999
  const exposed = db.sessionForTest(session.id)!
  exposed.absoluteExpiresAt = 99999
  const exposedAccount = db.accountForTest(account.id)!
  exposedAccount.disabled = true
  expect(db.sessionForTest(session.id)).toEqual(session)
  expect((await db.authorizeAndTouch(session.id, 300, policy)).ok).toBe(true)
})
test('version exhaustion rejects invalidation without wrapping or falsely reporting success', async () => {
  const max = Number.MAX_SAFE_INTEGER
  const db = new MemorySessionRepository(
    [{ ...account, sessionVersion: max }],
    [{ ...session, accountVersion: max }],
  )
  await expect(db.revokeAccountSessions(account.id)).rejects.toThrow(
    'Session version exhausted',
  )
  expect(db.accountForTest(account.id)?.sessionVersion).toBe(max)
})
test('duplicate, unowned and malformed fixtures are rejected', () => {
  expect(() => new MemorySessionRepository([account, account], [])).toThrow(
    'Invalid session fixture',
  )
  expect(
    () => new MemorySessionRepository([account], [session, session]),
  ).toThrow('Invalid session fixture')
  expect(() => new MemorySessionRepository([], [session])).toThrow(
    'Invalid session fixture',
  )
  expect(
    () =>
      new MemorySessionRepository([account], [{ ...session, lastSeenAt: NaN }]),
  ).toThrow('Invalid session fixture')
})
