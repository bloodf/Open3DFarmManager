import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import {
  bootstrapOwner,
  createFarmInvite,
  registerWithInvite,
} from '../../apps/farm/server/services/account-registration.ts'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { MemorySessionRepository } from '../helpers/memory-session-repository.ts'

// scrypt cost is covered by password tests; keep this file fast.
vi.mock('../../apps/farm/server/utils/auth/password.ts', async (original) => ({
  ...(await original<object>()),
  hashPassword: async () => '$scrypt$synthetic-hash',
}))

const origin = 'https://farm.example.invalid'
const secret = 'synthetic-bootstrap-secret-0123456789abcdef'
const goodPassword = 'synthetic-long-password'
const farmId = '11111111-1111-4111-8111-111111111111'

function event(
  path: string,
  headers: Record<string, string>,
  body: unknown,
  withOrigin = true,
) {
  return {
    req: new Request(origin + path, {
      method: 'POST',
      headers: {
        ...(withOrigin ? { origin } : {}),
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    res: { status: 200, statusText: 'OK', headers: new Headers() },
  }
}
function fixture(registration: Partial<AuthRuntime['registration']> = {}) {
  const now = Date.now()
  const calls = { limits: [] as string[] }
  const runtime: AuthRuntime = {
    origin,
    cookie: {
      name: SESSION_COOKIE_NAME,
      password: 'synthetic-cookie-key-never-used-outside-tests',
      maxAge: 60,
      cookie: { ...SESSION_COOKIE_ATTRIBUTES },
    },
    sessions: new MemorySessionRepository(
      [{ id: 'owner', sessionVersion: 0, disabled: false }],
      [
        {
          id: 'owner_session',
          accountId: 'owner',
          accountVersion: 0,
          createdAt: now,
          lastSeenAt: now,
          absoluteExpiresAt: now + 60000,
          revokedAt: null,
        },
      ],
    ),
    idleTimeoutMs: 60000,
    lifetimeMs: 60000,
    bootstrapTokenDigest: createHash('sha256').update(secret).digest(),
    credentials: {
      async consumeLimit(kind, key) {
        calls.limits.push(kind + ':' + key)
        return true
      },
      async find() {
        return {
          accountId: 'owner',
          passwordHash: 'unused',
          credentialVersion: '0',
          sessionVersion: '0',
        }
      },
      async issue() {
        return 'owner_session'
      },
    },
    registration: {
      bootstrap: vi.fn(async () => true),
      register: vi.fn(async () => true),
      createInvite: vi.fn(async () => new Date('2030-01-01T00:00:00Z')),
      ...registration,
    },
  }
  return { runtime, calls }
}
const credentials = { username: 'novo_usuario', password: goodPassword }

describe('first-owner bootstrap', () => {
  test('correct secret creates the account and a host-only session cookie', async () => {
    const { runtime } = fixture()
    const req = event(
      '/api/auth/bootstrap',
      { 'x-bootstrap-token': secret },
      credentials,
    )
    expect(await bootstrapOwner(req, runtime)).toEqual({ accountId: 'owner' })
    expect(runtime.registration!.bootstrap).toHaveBeenCalledWith(
      'novo_usuario',
      expect.stringMatching(/^\$scrypt\$/),
    )
    const cookie = req.res.headers.getSetCookie()[0]
    expect(cookie).toContain(SESSION_COOKIE_NAME)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Domain=')
    expect(req.res.headers.get('cache-control')).toBe('no-store')
  })
  test.each([
    ['wrong secret', 'x'.repeat(40)],
    ['missing secret', ''],
  ])('%s fails generically without touching storage', async (_name, token) => {
    const { runtime } = fixture()
    const req = event(
      '/api/auth/bootstrap',
      token ? { 'x-bootstrap-token': token } : {},
      credentials,
    )
    await expect(bootstrapOwner(req, runtime)).rejects.toMatchObject({
      status: 400,
    })
    expect(runtime.registration!.bootstrap).not.toHaveBeenCalled()
  })
  test('disabled when no secret is configured, same response as wrong secret', async () => {
    const { runtime } = fixture()
    delete runtime.bootstrapTokenDigest
    await expect(
      bootstrapOwner(
        event('/x', { 'x-bootstrap-token': secret }, credentials),
        runtime,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })
  test('refuses once an account exists with the same generic message', async () => {
    const { runtime } = fixture({ bootstrap: vi.fn(async () => false) })
    const closed = await bootstrapOwner(
      event('/x', { 'x-bootstrap-token': secret }, credentials),
      runtime,
    ).catch((error) => error)
    const wrong = await bootstrapOwner(
      event('/x', { 'x-bootstrap-token': 'y'.repeat(40) }, credentials),
      runtime,
    ).catch((error) => error)
    expect(closed.status).toBe(400)
    expect(closed.message).toBe(wrong.message)
  })
  test('cross-origin and weak passwords are rejected before storage', async () => {
    const { runtime } = fixture()
    await expect(
      bootstrapOwner(
        event(
          '/x',
          { 'x-bootstrap-token': secret, origin: 'https://evil.example' },
          credentials,
        ),
        runtime,
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      bootstrapOwner(
        event(
          '/x',
          { 'x-bootstrap-token': secret },
          {
            username: 'novo_usuario',
            password: 'short',
          },
        ),
        runtime,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(runtime.registration!.bootstrap).not.toHaveBeenCalled()
  })
})

describe('invite registration', () => {
  const token = 'A'.repeat(43)
  test('valid invite passes only the token digest to storage and starts a session', async () => {
    const { runtime, calls } = fixture()
    const req = event(
      '/api/auth/register',
      { 'x-invite-token': token },
      credentials,
    )
    expect(await registerWithInvite(req, runtime)).toEqual({
      accountId: 'owner',
    })
    expect(runtime.registration!.register).toHaveBeenCalledWith(
      createHash('sha256').update(token).digest('hex'),
      'novo_usuario',
      expect.any(String),
    )
    expect(req.res.headers.getSetCookie()).toHaveLength(1)
    expect(calls.limits).toContain('a:register:novo_usuario')
  })
  test('malformed, spent or conflicting invites share one generic failure', async () => {
    const spent = fixture({ register: vi.fn(async () => false) })
    const results = await Promise.all([
      registerWithInvite(
        event('/x', { 'x-invite-token': 'short' }, credentials),
        spent.runtime,
      ).catch((error) => error),
      registerWithInvite(
        event('/x', { 'x-invite-token': token }, credentials),
        spent.runtime,
      ).catch((error) => error),
      registerWithInvite(event('/x', {}, credentials), spent.runtime).catch(
        (error) => error,
      ),
    ])
    for (const result of results) {
      expect(result.status).toBe(400)
      expect(result.message).toBe(results[0].message)
    }
  })
  test('cross-origin registration is refused', async () => {
    const { runtime } = fixture()
    await expect(
      registerWithInvite(
        event('/x', { 'x-invite-token': token }, credentials, false),
        runtime,
      ),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('farm owner invite creation', () => {
  async function cookieHeader(runtime: AuthRuntime) {
    const req = event(
      '/api/auth/bootstrap',
      { 'x-bootstrap-token': secret },
      credentials,
    )
    await bootstrapOwner(req, runtime)
    return req.res.headers.getSetCookie()[0]!.split(';')[0]!
  }
  test('owner receives a 43-char token once; storage only gets its digest', async () => {
    const { runtime } = fixture()
    const cookie = await cookieHeader(runtime)
    const result = await createFarmInvite(
      event(`/api/farms/${farmId}/invites`, { cookie }, { role: 'operator' }),
      runtime,
      farmId,
    )
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result).toMatchObject({
      role: 'operator',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    const args = vi.mocked(runtime.registration!.createInvite).mock.calls[0]!
    expect(args.slice(0, 3)).toEqual(['owner', farmId, 'operator'])
    expect(args[3]).toBe(
      createHash('sha256').update(result.token).digest('hex'),
    )
    expect(JSON.stringify(args)).not.toContain(result.token)
  })
  test('non-owner gets 403, owner role cannot be invited, anonymous gets 401', async () => {
    const { runtime } = fixture({ createInvite: vi.fn(async () => null) })
    const cookie = await cookieHeader(runtime)
    await expect(
      createFarmInvite(
        event('/x', { cookie }, { role: 'viewer' }),
        runtime,
        farmId,
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      createFarmInvite(
        event('/x', { cookie }, { role: 'owner' }),
        runtime,
        farmId,
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      createFarmInvite(event('/x', {}, { role: 'viewer' }), runtime, farmId),
    ).rejects.toMatchObject({ status: 401 })
  })
})
