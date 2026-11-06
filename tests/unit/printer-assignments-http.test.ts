import { beforeAll, expect, test } from 'vitest'
import {
  printerAssignments,
  printerAssignmentBoundary,
  readPrinterAssignmentBody,
} from '../../apps/farm/server/services/printer-assignments.ts'

// Use the real login/sealing path; persistence is replaced at its public boundary.
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import type { PrinterAssignmentsRuntime } from '../../apps/farm/server/utils/printer-assignments/runtime.ts'
import type { SessionDecision } from '../../apps/farm/server/utils/auth/session-contract.ts'
import type { PrinterOwnershipRequest } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'

const origin = 'https://farm.example.invalid'
const makeRequest = (body = '{}', headers: Record<string, string> = {}) =>
  new Request(
    origin + '/api/farms/11111111-1111-4111-8111-111111111111/printers',
    {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body,
    },
  )

test('assignment mutations require an exact origin and bounded JSON transport', () => {
  expect(() =>
    printerAssignmentBoundary(makeRequest(), origin, 'register'),
  ).not.toThrow()
  for (const headers of [
    { origin: '' },
    { origin: 'null' },
    { origin: origin + '/' },
    { origin: 'https://evil.invalid' },
    { 'content-type': 'text/plain' },
    { 'content-encoding': 'gzip' },
    { 'content-length': '4097' },
  ])
    expect(() =>
      printerAssignmentBoundary(makeRequest('{}', headers), origin, 'register'),
    ).toThrow()
  const noOrigin = new Request(origin + '/api/farms/x/printers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(() =>
    printerAssignmentBoundary(noOrigin, origin, 'register'),
  ).toThrow()
})

test('assignment body rejects malformed, duplicate, excessive and nested JSON', async () => {
  expect(
    await readPrinterAssignmentBody(
      makeRequest('{"printerKey":" Printer é "}'),
    ),
  ).toEqual({ printerKey: ' Printer é ' })
  for (const body of [
    '{',
    '{"a":1,"a":2}',
    ' '.repeat(4097),
    '{"a":{"b":{"c":1}}}',
  ])
    await expect(readPrinterAssignmentBody(makeRequest(body))).rejects.toThrow()
})

const farmId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const assignmentId = '33333333-3333-4333-8333-333333333333'
const sessionRecordId = 'assignment-session'
let cookie = ''
const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-assignment-test-secret-32-characters',
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
} satisfies AuthRuntime['cookie']
function fixture() {
  const calls: string[] = []
  const registered: PrinterOwnershipRequest[] = []
  const revoked: (PrinterOwnershipRequest & {
    expectedAssignmentId: string
  })[] = []
  const listed: Parameters<
    PrinterAssignmentsRuntime['inventory']['list']
  >[0][] = []
  const state: {
    decision: SessionDecision
    quota: boolean
    quotaFailure: boolean
  } = {
    decision: { ok: true, accountId: 'account', touchAt: Date.now() },
    quota: true,
    quotaFailure: false,
  }
  const auth: AuthRuntime = {
    origin,
    cookie: cookieConfig,
    idleTimeoutMs: 60000,
    lifetimeMs: 3600000,
    sessions: {
      async authorizeAndTouch(id) {
        expect(id).toBe(sessionRecordId)
        calls.push('authorize')
        return state.decision
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit(kind, key) {
        calls.push(`quota:${kind}:${key}`)
        if (state.quotaFailure) throw new Error('database unavailable')
        return state.quota
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
  }
  const runtime: PrinterAssignmentsRuntime = {
    ownership: {
      async register(input) {
        calls.push('register')
        registered.push(input)
        return { ok: true, assignmentId, status: 'active' }
      },
      async revoke(input) {
        calls.push('revoke')
        revoked.push(input)
        return {
          ok: true,
          assignmentId: input.expectedAssignmentId,
          status: 'revoked',
        }
      },
    },
    inventory: {
      async list(input) {
        calls.push('list')
        listed.push(input)
        return { ok: true, printers: [], nextAfter: null, canManage: false }
      },
    },
  }
  function event(body?: unknown, sessionCookie = cookie, query = '') {
    const headers = {
      cookie: sessionCookie,
      origin,
      'content-type': 'application/json',
    }
    return {
      req: new Request(
        `${origin}/api/farms/${farmId}/printers${query}`,
        body === undefined
          ? { headers }
          : { method: 'POST', headers, body: JSON.stringify(body) },
      ),
      res: { headers: new Headers() },
    }
  }
  return { auth, runtime, event, calls, registered, revoked, listed, state }
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
  const event = f.event(
    { username: 'operator', password: 'synthetic-test-password' },
    '',
  )
  await login(event, f.auth)
  cookie = event.res.headers.getSetCookie().at(-1)?.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
})

test('sealed login and fresh database authorization precede operation/session quota', async () => {
  for (const reason of [
    'revoked',
    'expired',
    'missing',
    'storage-unavailable',
  ] as const) {
    const f = fixture()
    f.state.decision = { ok: false, reason }
    await expect(
      printerAssignments(f.event(), 'list', { farmId }, f),
    ).rejects.toMatchObject({
      status: reason === 'storage-unavailable' ? 503 : 401,
    })
    expect(f.calls).toEqual(['authorize'])
  }
  for (const invalidCookie of [
    '',
    `${SESSION_COOKIE_NAME}=unsealed`,
    `${SESSION_COOKIE_NAME}=${sessionRecordId}`,
  ]) {
    const f = fixture()
    const event = f.event(undefined, invalidCookie)
    await expect(
      printerAssignments(event, 'list', { farmId }, f),
    ).rejects.toMatchObject({ status: 401 })
    expect(f.calls).toEqual([])
    expect(event.res.headers.get('cache-control')).toBe('no-store')
    expect(event.res.headers.get('referrer-policy')).toBe('no-referrer')
  }
})

test('quota denial or failure stops storage after authenticated authorization', async () => {
  for (const failure of [false, true]) {
    const f = fixture()
    f.state.quota = false
    f.state.quotaFailure = failure
    await expect(
      printerAssignments(f.event(), 'list', { farmId }, f),
    ).rejects.toMatchObject({ status: failure ? 503 : 429 })
    expect(f.calls).toEqual([
      'authorize',
      `quota:s:printer-assignments:list:${sessionRecordId}`,
    ])
  }
})

test('list forwards bounded keysets with sealed session authority', async () => {
  const f = fixture()
  expect(await printerAssignments(f.event(), 'list', { farmId }, f)).toEqual({
    printers: [],
    nextAfter: null,
    canManage: false,
  })
  expect(f.listed).toEqual([
    {
      farmId,
      sessionRecordId,
      policy: { idleTimeoutMs: 60000 },
      limit: 20,
      after: null,
    },
  ])
  expect(f.calls).toEqual([
    'authorize',
    `quota:s:printer-assignments:list:${sessionRecordId}`,
    'list',
  ])
  const next = fixture()
  await printerAssignments(
    next.event(undefined, cookie, `?limit=50&after=${assignmentId}`),
    'list',
    { farmId },
    next,
  )
  expect(next.listed[0]).toMatchObject({ limit: 50, after: assignmentId })
  for (const query of [
    '?limit=51',
    '?limit=0',
    '?limit=1&limit=2',
    '?after=bad',
    '?url=https://example.invalid',
  ]) {
    const invalid = fixture()
    await expect(
      printerAssignments(
        invalid.event(undefined, cookie, query),
        'list',
        { farmId },
        invalid,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(invalid.calls).toEqual([])
  }
})

test('registration preserves exact opaque keys and treats local confirmation only as attestation', async () => {
  for (const printerKey of [
    ' Printer é ',
    'e\u0301',
    '🖨️',
    'x'.repeat(128),
    'https://opaque.invalid/printer',
  ]) {
    const f = fixture()
    expect(
      await printerAssignments(
        f.event({ agentId, printerKey, confirmedLocalConfiguration: true }),
        'register',
        { farmId },
        f,
      ),
    ).toEqual({ assignmentId, status: 'active' })
    expect(f.registered).toEqual([
      {
        farmId,
        agentId,
        printerKey,
        sessionRecordId,
        policy: { idleTimeoutMs: 60000 },
      },
    ])
    expect(f.calls).toEqual([
      'authorize',
      `quota:s:printer-assignments:register:${sessionRecordId}`,
      'register',
    ])
  }
})

test('registration rejects invalid keys, missing attestation and discovery fields', async () => {
  const valid = {
    agentId,
    printerKey: 'exact',
    confirmedLocalConfiguration: true,
  }
  for (const body of [
    { ...valid, confirmedLocalConfiguration: false },
    { agentId, printerKey: 'exact' },
    { ...valid, url: 'http://printer.invalid' },
    { ...valid, accountId: 'other' },
    { ...valid, printerKey: '' },
    { ...valid, printerKey: 'x'.repeat(129) },
    { ...valid, printerKey: '\0' },
    { ...valid, printerKey: '\ud800' },
    { ...valid, printerKey: '\udc00' },
    { ...valid, agentId: 'invalid' },
  ]) {
    const f = fixture()
    await expect(
      printerAssignments(f.event(body), 'register', { farmId }, f),
    ).rejects.toMatchObject({ status: 400 })
    expect(f.registered).toEqual([])
  }
})

test('revocation passes the immutable route ID and exact identity, rejecting overrides', async () => {
  const f = fixture()
  const printerKey = ' Exact é '
  expect(
    await printerAssignments(
      f.event({ agentId, printerKey }),
      'revoke',
      { farmId, assignmentId },
      f,
    ),
  ).toEqual({ assignmentId, status: 'revoked' })
  expect(f.revoked).toEqual([
    {
      farmId,
      agentId,
      printerKey,
      sessionRecordId,
      policy: { idleTimeoutMs: 60000 },
      expectedAssignmentId: assignmentId,
    },
  ])
  for (const body of [
    { agentId, printerKey, expectedAssignmentId: agentId },
    { agentId, printerKey, assignmentId: agentId },
  ]) {
    const invalid = fixture()
    await expect(
      printerAssignments(
        invalid.event(body),
        'revoke',
        { farmId, assignmentId },
        invalid,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(invalid.revoked).toEqual([])
  }
  await expect(
    printerAssignments(
      f.event({ agentId, printerKey }),
      'revoke',
      { farmId },
      f,
    ),
  ).rejects.toMatchObject({ status: 400 })
})

test('storage denial, conflict and outages fail closed without leaking internal errors', async () => {
  for (const [reason, status] of [
    ['denied', 403],
    ['conflict', 409],
    ['storage-unavailable', 503],
  ] as const) {
    const f = fixture()
    f.runtime.ownership.register = async () => ({ ok: false, reason })
    await expect(
      printerAssignments(
        f.event({
          agentId,
          printerKey: 'exact',
          confirmedLocalConfiguration: true,
        }),
        'register',
        { farmId },
        f,
      ),
    ).rejects.toMatchObject({ status })
  }
  for (const [reason, status] of [
    ['forbidden', 403],
    ['unauthorized', 401],
    ['storage-unavailable', 503],
  ] as const) {
    const f = fixture()
    f.runtime.inventory.list = async () => ({ ok: false, reason })
    await expect(
      printerAssignments(f.event(), 'list', { farmId }, f),
    ).rejects.toMatchObject({ status })
  }
})

test('streamed bodies are bounded, canceled and decoded as strict UTF-8', async () => {
  let canceled = false
  const oversized = new Request(origin, {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4097))
      },
      cancel() {
        canceled = true
      },
    }),
  })
  await expect(readPrinterAssignmentBody(oversized)).rejects.toMatchObject({
    status: 413,
  })
  expect(canceled).toBe(true)
  const invalidUtf8 = new Request(origin, {
    method: 'POST',
    body: new Uint8Array([0x22, 0xc0, 0xaf, 0x22]),
  })
  await expect(readPrinterAssignmentBody(invalidUtf8)).rejects.toMatchObject({
    status: 400,
  })
})

test('a stalled body times out and releases its stream', async () => {
  let canceled = false
  const stalled = new Request(origin, {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true
      },
    }),
  })
  await expect(readPrinterAssignmentBody(stalled)).rejects.toMatchObject({
    status: 408,
  })
  expect(canceled).toBe(true)
}, 7000)
