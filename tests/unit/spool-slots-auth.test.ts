import { beforeAll, expect, test } from 'vitest'
import {
  spoolSlotsFeature,
  type SlotOperation,
  type SlotsDeps,
} from '../../apps/farm/server/services/spool-slots-http.ts'
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import {
  SlotAccessError,
  type SlotRole,
} from '../../apps/farm/server/storage/postgres-spool-slot-access.ts'

const origin = 'https://farm.example.invalid'
const ownFarm = '11111111-1111-4111-8111-111111111111'
const otherFarm = '44444444-4444-4444-8444-444444444444'
const printerId = '22222222-2222-4222-8222-222222222222'
const sessionRecordId = 'slots-session'
const cookieConfig = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-slots-test-secret-32-characters!!',
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
} satisfies AuthRuntime['cookie']
let cookie = ''

/** Membership table of the fake: farm -> role of the signed-in account. */
function fixture(memberships: Record<string, SlotRole>) {
  const calls: string[] = []
  const stored: unknown[] = []
  const auth: AuthRuntime = {
    origin,
    cookie: cookieConfig,
    idleTimeoutMs: 60000,
    lifetimeMs: 3600000,
    sessions: {
      async authorizeAndTouch() {
        throw new Error('unused')
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit() {
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
  const deps: SlotsDeps = {
    auth,
    access: {
      async authorize(authority) {
        calls.push(`authorize:${authority.farmId}`)
        expect(authority.sessionRecordId).toBe(sessionRecordId)
        const role = memberships[authority.farmId]
        if (!role) throw new SlotAccessError(404)
        return role
      },
    },
    slots: {
      async list(input) {
        calls.push('storage:list')
        stored.push(input)
        return []
      },
      async assign(input) {
        calls.push('storage:assign')
        stored.push(input)
        return {
          farmId: input.farmId,
          id: 'a',
          spoolId: input.spoolId,
          printerId: input.printerId,
          slotKind: input.slotKind,
          slotIndex: input.slotIndex,
          assignedAt: 1,
          unassignedAt: null,
        }
      },
      async unassign(input) {
        calls.push('storage:unassign')
        stored.push(input)
        return true
      },
    },
  }
  return { deps, calls, stored }
}

function event(
  op: SlotOperation,
  farmId: string,
  options: {
    cookie?: string | undefined
    origin?: string | null
    body?: unknown
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  const c = 'cookie' in options ? options.cookie : cookie
  if (c) headers.cookie = c
  const o = 'origin' in options ? options.origin : origin
  if (o !== null && o !== undefined) headers.origin = o
  const base = `${origin}/api/farms/${farmId}/spool-library/slots`
  const bodies: Record<SlotOperation, unknown> = {
    list: undefined,
    assign: { spoolId: 7, printerId, slotKind: 'ams', slotIndex: 2 },
    unassign: { printerId, slotKind: 'ams', slotIndex: 2 },
  }
  const body = 'body' in options ? options.body : bodies[op]
  return {
    req:
      op === 'list'
        ? new Request(`${base}?printerId=${printerId}`, { headers })
        : new Request(op === 'assign' ? base : `${base}/unassign`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
    res: { headers: new Headers() },
  }
}

beforeAll(async () => {
  const f = fixture({})
  const passwordHash = await hashPassword('synthetic-test-password')
  f.deps.auth.credentials.find = async () => ({
    accountId: 'account',
    passwordHash,
    credentialVersion: '1',
    sessionVersion: '1',
  })
  f.deps.auth.credentials.issue = async () => sessionRecordId
  const login_ = {
    req: new Request(`${origin}/api/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'operator',
        password: 'synthetic-test-password',
      }),
    }),
    res: { headers: new Headers() },
  }
  await login(login_, f.deps.auth)
  cookie = login_.res.headers.getSetCookie().at(-1)?.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
})

const ops: SlotOperation[] = ['list', 'assign', 'unassign']

test.each(ops)('%s refuses anonymous callers before storage', async (op) => {
  const f = fixture({ [ownFarm]: 'owner' })
  for (const c of [undefined, '', `${SESSION_COOKIE_NAME}=forged`])
    await expect(
      spoolSlotsFeature(event(op, ownFarm, { cookie: c }), ownFarm, op, f.deps),
    ).rejects.toMatchObject({ status: 401 })
  expect(f.calls).toEqual([])
})

test.each(ops)('%s refuses members of another farm', async (op) => {
  const f = fixture({ [otherFarm]: 'owner' })
  await expect(
    spoolSlotsFeature(event(op, ownFarm), ownFarm, op, f.deps),
  ).rejects.toMatchObject({ status: 404 })
  expect(f.calls).toEqual([`authorize:${ownFarm}`])
})

test.each(['assign', 'unassign'] as const)('%s refuses viewers', async (op) => {
  const f = fixture({ [ownFarm]: 'viewer' })
  await expect(
    spoolSlotsFeature(event(op, ownFarm), ownFarm, op, f.deps),
  ).rejects.toMatchObject({ status: 403 })
  expect(f.stored).toEqual([])
})

test('viewers may list', async () => {
  const f = fixture({ [ownFarm]: 'viewer' })
  await expect(
    spoolSlotsFeature(event('list', ownFarm), ownFarm, 'list', f.deps),
  ).resolves.toEqual({ assignments: [] })
})

test.each(['assign', 'unassign'] as const)(
  '%s refuses a missing or foreign Origin before any lookup',
  async (op) => {
    const f = fixture({ [ownFarm]: 'owner' })
    for (const o of [null, 'null', 'https://evil.invalid', origin + '/'])
      await expect(
        spoolSlotsFeature(
          event(op, ownFarm, { origin: o }),
          ownFarm,
          op,
          f.deps,
        ),
      ).rejects.toMatchObject({ status: 403 })
    expect(f.calls).toEqual([])
  },
)

test('an authorized operator reaches storage with the path farm', async () => {
  const f = fixture({ [ownFarm]: 'operator' })
  const listed = await spoolSlotsFeature(
    event('list', ownFarm),
    ownFarm,
    'list',
    f.deps,
  )
  expect(listed).toEqual({ assignments: [] })
  const assigned = (await spoolSlotsFeature(
    event('assign', ownFarm),
    ownFarm,
    'assign',
    f.deps,
  )) as { assignment: { farmId: string; spoolId: number } }
  expect(assigned.assignment).toMatchObject({ farmId: ownFarm, spoolId: 7 })
  await expect(
    spoolSlotsFeature(event('unassign', ownFarm), ownFarm, 'unassign', f.deps),
  ).resolves.toEqual({ unassigned: true })
  expect(f.stored).toEqual([
    { farmId: ownFarm, printerId, spoolId: undefined },
    { farmId: ownFarm, spoolId: 7, printerId, slotKind: 'ams', slotIndex: 2 },
    { farmId: ownFarm, printerId, slotKind: 'ams', slotIndex: 2 },
  ])
})

test('request validation is kept after authorization', async () => {
  const f = fixture({ [ownFarm]: 'owner' })
  await expect(
    spoolSlotsFeature(
      event('assign', ownFarm, { body: { spoolId: 0, printerId } }),
      ownFarm,
      'assign',
      f.deps,
    ),
  ).rejects.toMatchObject({ status: 400 })
  const bad = event('list', ownFarm)
  const withBadSpool = {
    ...bad,
    req: new Request(`${origin}/x?spoolId=abc`, {
      headers: { cookie },
    }),
  }
  await expect(
    spoolSlotsFeature(withBadSpool, ownFarm, 'list', f.deps),
  ).rejects.toMatchObject({ status: 400 })
  expect(f.stored).toEqual([])
})
