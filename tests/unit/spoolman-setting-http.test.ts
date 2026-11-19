import { beforeAll, expect, test } from 'vitest'
import { spoolmanFarmSetting } from '../../apps/farm/server/services/spoolman-farm-setting.ts'
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { SpoolmanSettingsRuntime } from '../../apps/farm/server/utils/spoolman-settings/runtime.ts'
import type { SessionDecision } from '../../apps/farm/server/utils/auth/session-contract.ts'

const origin = 'https://farm.example.invalid'
const farmId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const sessionRecordId = 'spoolman-session'
let cookie = ''
const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-spoolman-test-secret-32-characters',
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
} satisfies AuthRuntime['cookie']

function fixture() {
  const calls: string[] = []
  const saved: unknown[] = []
  const state: {
    decision: SessionDecision
    save: Awaited<ReturnType<SpoolmanSettingsRuntime['settings']['save']>>
  } = {
    decision: { ok: true, accountId: 'account', touchAt: Date.now() },
    save: {
      ok: true,
      setting: {
        agentId,
        origin: 'http://192.168.1.60:7912',
        status: 'reachable',
        configured: true,
        checkedAt: 1,
      },
    },
  }
  const auth: AuthRuntime = {
    origin,
    cookie: cookieConfig,
    idleTimeoutMs: 60000,
    lifetimeMs: 3600000,
    sessions: {
      async authorizeAndTouch() {
        calls.push('authorize')
        return state.decision
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit(kind, key) {
        calls.push(`quota:${kind}:${key}`)
        return true
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
  }
  const runtime: SpoolmanSettingsRuntime = {
    settings: {
      async list() {
        calls.push('list')
        return { ok: true, settings: [], canManage: true }
      },
      async save(input) {
        calls.push('save')
        saved.push(input)
        return state.save
      },
    },
  }
  function event(
    method: 'GET' | 'PUT',
    body?: unknown,
    sessionCookie = cookie,
  ) {
    const headers = {
      cookie: sessionCookie,
      origin,
      'content-type': 'application/json',
    }
    return {
      req: new Request(`${origin}/api/farms/${farmId}/spoolman`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      res: { headers: new Headers() },
    }
  }
  return { auth, runtime, event, calls, saved, state }
}

beforeAll(async () => {
  const f = fixture()
  const passwordHash = await hashPassword('synthetic-test-password')
  f.auth.credentials.find = async () => ({
    accountId: 'account',
    passwordHash,
    credentialVersion: '1',
    sessionVersion: '1',
  })
  f.auth.credentials.issue = async () => sessionRecordId
  const login_ = {
    req: new Request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'operator',
        password: 'synthetic-test-password',
      }),
    }),
    res: { headers: new Headers() },
  }
  await login(login_, f.auth)
  cookie = login_.res.headers.getSetCookie().at(-1)?.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
})

const good = {
  agentId,
  origin: 'http://192.168.1.60:7912/',
  status: 'reachable',
  configured: true,
}

test('PUT stores only the non-secret outcome, with the origin canonicalized', async () => {
  const f = fixture()
  const result = await spoolmanFarmSetting(
    f.event('PUT', good),
    'put',
    { farmId },
    f,
  )
  expect(result.setting).toMatchObject({ agentId, status: 'reachable' })
  expect(f.saved).toEqual([
    {
      sessionRecordId,
      policy: { idleTimeoutMs: 60000 },
      farmId,
      agentId,
      origin: 'http://192.168.1.60:7912',
      status: 'reachable',
      configured: true,
    },
  ])
  expect(f.calls).toEqual([
    'authorize',
    `quota:s:spoolman-setting:put:${sessionRecordId}`,
    'save',
  ])
})

test('any credential-shaped or unknown field is rejected before storage', async () => {
  for (const extra of [
    { password: 'segredo' },
    { username: 'ana' },
    { token: 'segredo' },
    { apiKey: 'segredo' },
    { headers: { authorization: 'Bearer x' } },
  ]) {
    const f = fixture()
    await expect(
      spoolmanFarmSetting(
        f.event('PUT', { ...good, ...extra }),
        'put',
        { farmId },
        f,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(f.saved).toEqual([])
  }
  for (const origin of [
    'http://user:pw@192.168.1.60:7912',
    'http://192.168.1.60:7912/path',
    'javascript:alert(1)',
  ]) {
    const f = fixture()
    await expect(
      spoolmanFarmSetting(
        f.event('PUT', { ...good, origin }),
        'put',
        { farmId },
        f,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(f.saved).toEqual([])
  }
})

test('mutation needs session, exact origin, JSON; role and Connector failures map to HTTP errors', async () => {
  const f = fixture()
  await expect(
    spoolmanFarmSetting(f.event('PUT', good, ''), 'put', { farmId }, f),
  ).rejects.toMatchObject({ status: 401 })
  expect(f.saved).toEqual([])
  const cross = f.event('PUT', good)
  cross.req = new Request(cross.req.url, {
    method: 'PUT',
    headers: {
      cookie,
      origin: 'https://evil.invalid',
      'content-type': 'application/json',
    },
    body: JSON.stringify(good),
  })
  await expect(
    spoolmanFarmSetting(cross, 'put', { farmId }, fixture()),
  ).rejects.toMatchObject({ status: 403 })
  for (const [reason, status] of [
    ['denied', 403],
    ['forbidden', 404],
    ['unauthorized', 401],
    ['storage-unavailable', 503],
  ] as const) {
    const g = fixture()
    g.state.save = { ok: false, reason }
    await expect(
      spoolmanFarmSetting(g.event('PUT', good), 'put', { farmId }, g),
    ).rejects.toMatchObject({ status })
  }
})

test('GET lists the non-secret settings behind the same session checks', async () => {
  const f = fixture()
  expect(
    await spoolmanFarmSetting(f.event('GET'), 'get', { farmId }, f),
  ).toEqual({
    settings: [],
    canManage: true,
  })
  expect(f.calls).toEqual([
    'authorize',
    `quota:s:spoolman-setting:get:${sessionRecordId}`,
    'list',
  ])
  const g = fixture()
  await expect(
    spoolmanFarmSetting(g.event('GET', undefined, ''), 'get', { farmId }, g),
  ).rejects.toMatchObject({ status: 401 })
})
