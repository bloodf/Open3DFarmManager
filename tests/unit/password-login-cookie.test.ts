import { beforeAll, describe, expect, test } from 'vitest'
import {
  authenticatedSession,
  login,
  logout,
} from '../../apps/farm/server/services/authenticated-session.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { MemorySessionRepository } from '../helpers/memory-session-repository.ts'

let passwordHash: string
beforeAll(async () => {
  passwordHash = await hashPassword('synthetic-test-password')
})
function event(
  method: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  return {
    req: new Request('https://farm.example.invalid/api/auth/login', {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    }),
    res: { status: 200, statusText: 'OK', headers: new Headers() },
  }
}
function fixture() {
  const now = Date.now()
  let checks = 0
  const sessions = new MemorySessionRepository(
    [{ id: 'account', sessionVersion: 0, disabled: false }],
    [
      {
        id: 'independent_session',
        accountId: 'account',
        accountVersion: 0,
        createdAt: now,
        lastSeenAt: now,
        absoluteExpiresAt: now + 60000,
        revokedAt: null,
      },
    ],
  )
  const runtime: AuthRuntime = {
    origin: 'https://farm.example.invalid',
    cookie: {
      name: SESSION_COOKIE_NAME,
      password: 'synthetic-cookie-key-never-used-outside-tests',
      maxAge: 60,
      cookie: { ...SESSION_COOKIE_ATTRIBUTES },
    },
    sessions,
    idleTimeoutMs: 60000,
    lifetimeMs: 60000,
    credentials: {
      async consumeLimit() {
        return true
      },
      async find() {
        return {
          accountId: 'account',
          passwordHash,
          credentialVersion: '0',
          sessionVersion: '0',
        }
      },
      async issue() {
        checks++
        return 'independent_session'
      },
    },
  }
  return { runtime, sessions, checks: () => checks }
}
async function signIn(runtime: AuthRuntime) {
  const req = event(
    'POST',
    { origin: runtime.origin, 'content-type': 'application/json' },
    JSON.stringify({
      username: 'fixture_user',
      password: 'synthetic-test-password',
    }),
  )
  expect(await login(req, runtime)).toEqual({ accountId: 'account' })
  const cookie = req.res.headers.getSetCookie()[0]
  expect(cookie).toBeDefined()
  return cookie!
}
describe('maintained Nuxt sealed-cookie session request behavior', () => {
  test('login cookie is host-only; header bearers cannot authenticate; DB revocation rejects replay', async () => {
    const { runtime, sessions } = fixture()
    const cookie = await signIn(runtime)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain=')
    const pair = cookie.split(';')[0]!
    const bearer = pair.slice(pair.indexOf('=') + 1)
    for (const headers of [
      { authorization: 'Bearer ' + bearer },
      { 'x-session': bearer },
      { ['x-' + SESSION_COOKIE_NAME]: bearer },
    ]) {
      await expect(
        authenticatedSession(event('GET', headers), runtime),
      ).rejects.toMatchObject({ status: 401 })
    }
    expect(
      await authenticatedSession(event('GET', { cookie: pair }), runtime),
    ).toEqual({ accountId: 'account' })
    await sessions.revokeAccountSessions('account')
    await expect(
      authenticatedSession(event('GET', { cookie: pair }), runtime),
    ).rejects.toMatchObject({ status: 401 })
  })
  test('logout commits revocation before clearing and rejects cross-origin mutation', async () => {
    const { runtime } = fixture()
    const pair = (await signIn(runtime)).split(';')[0]!
    await expect(
      logout(
        event('POST', {
          cookie: pair,
          origin: 'https://other.example.invalid',
        }),
        runtime,
      ),
    ).rejects.toMatchObject({ status: 403 })
    const req = event('POST', { cookie: pair, origin: runtime.origin })
    expect(await logout(req, runtime)).toEqual({ loggedOut: true })
    expect(req.res.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    await expect(
      authenticatedSession(event('GET', { cookie: pair }), runtime),
    ).rejects.toMatchObject({ status: 401 })
  })
  test('storage error cannot report a successful logout or clear its cookie', async () => {
    const { runtime, sessions } = fixture()
    const pair = (await signIn(runtime)).split(';')[0]!
    sessions.setAvailableForTest(false)
    const req = event('POST', { cookie: pair, origin: runtime.origin })
    await expect(logout(req, runtime)).rejects.toMatchObject({ status: 503 })
    expect(req.res.headers.getSetCookie()).toEqual([])
  })
  test('missing Origin rejects login before issuing a session', async () => {
    const f = fixture()
    await expect(
      login(
        event('POST', { 'content-type': 'application/json' }, '{}'),
        f.runtime,
      ),
    ).rejects.toMatchObject({ status: 403 })
    expect(f.checks()).toBe(0)
  })
})
