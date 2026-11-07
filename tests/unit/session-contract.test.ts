import { expect, test } from 'vitest'
import {
  evaluateSession,
  type SessionRecord,
  type AccountSessionState,
} from '../../apps/farm/server/utils/auth/session-contract.ts'
const session: SessionRecord = {
  id: 'synthetic-session',
  accountId: 'synthetic-account',
  accountVersion: 2,
  createdAt: 100,
  lastSeenAt: 200,
  absoluteExpiresAt: 1000,
  revokedAt: null,
}
const account: AccountSessionState = {
  id: session.accountId,
  sessionVersion: 2,
  disabled: false,
}
const policy = { idleTimeoutMs: 300 }
const decide = (
  s: SessionRecord | null = session,
  a: AccountSessionState | null = account,
  now = 300,
) => evaluateSession(session.id, s, a, now, policy)

test('fresh active snapshot allows touch without mutating expiry or state', () => {
  const frozen = Object.freeze({ ...session })
  expect(decide(frozen)).toEqual({
    ok: true,
    accountId: account.id,
    touchAt: 300,
  })
  expect(frozen).toEqual(session)
})
test('missing session or account cannot be reconstructed from a cookie', () => {
  expect(decide(null)).toEqual({ ok: false, reason: 'missing' })
  expect(decide(session, null)).toEqual({ ok: false, reason: 'missing' })
})
test('logout, account disable and version changes reject an otherwise unexpired session', () => {
  expect(decide({ ...session, revokedAt: 250 })).toEqual({
    ok: false,
    reason: 'revoked',
  })
  expect(decide(session, { ...account, disabled: true })).toEqual({
    ok: false,
    reason: 'revoked',
  })
  for (const sessionVersion of [1, 3])
    expect(decide(session, { ...account, sessionVersion })).toEqual({
      ok: false,
      reason: 'revoked',
    })
})
test('idle and absolute deadlines are exclusive and activity cannot extend absolute expiry', () => {
  expect(decide(session, account, 499).ok).toBe(true)
  expect(decide(session, account, 500)).toEqual({
    ok: false,
    reason: 'expired',
  })
  const touched = { ...session, lastSeenAt: 900 }
  expect(decide(touched, account, 999).ok).toBe(true)
  expect(decide(touched, account, 1000)).toEqual({
    ok: false,
    reason: 'expired',
  })
})
test('mismatched session or account identity fails closed', () => {
  expect(decide({ ...session, id: 'other' })).toEqual({
    ok: false,
    reason: 'invalid-state',
  })
  expect(decide(session, { ...account, id: 'other' })).toEqual({
    ok: false,
    reason: 'invalid-state',
  })
})
test('invalid and regressing clocks fail closed without touching state', () => {
  for (const now of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 199])
    expect(decide(session, account, now)).toEqual({
      ok: false,
      reason: 'invalid-state',
    })
  for (const patch of [
    { createdAt: 201 },
    { lastSeenAt: 1000 },
    { absoluteExpiresAt: 0 },
    { revokedAt: 99 },
    { accountVersion: -1 },
    { lastSeenAt: NaN },
  ])
    expect(decide({ ...session, ...patch }).ok).toBe(false)
})
test('malformed runtime state and policy do not become successful decisions', () => {
  for (const malformed of [
    undefined,
    {},
    { ...session, revokedAt: undefined },
    { ...session, accountVersion: '2' },
  ])
    expect(
      evaluateSession(
        session.id,
        malformed as SessionRecord,
        account,
        300,
        policy,
      ).ok,
    ).toBe(false)
  for (const idleTimeoutMs of [0, -1, NaN, Infinity, 1.5])
    expect(
      evaluateSession(session.id, session, account, 300, { idleTimeoutMs }).ok,
    ).toBe(false)
  expect(
    decide(session, {
      ...account,
      disabled: undefined,
    } as unknown as AccountSessionState).ok,
  ).toBe(false)
})
