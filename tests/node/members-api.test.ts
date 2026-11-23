// Owner member, role and invite management (issue #217). No network, database or
// installed packages: the service runs against an in-memory store and session double.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  changeMemberRole,
  listInvites,
  listMembers,
  MembersError,
  removeMember,
  revokeInvite,
  type AssignableRole,
  type FarmInvite,
  type MemberRole,
  type MembersDeps,
  type MembersStore,
} from '../../apps/farm/server/services/members.ts'
import { MemorySessionRepository } from '../helpers/memory-session-repository.ts'

const origin = 'https://farm.example.invalid'
const farmId = '11111111-1111-4111-8111-111111111111'
const otherFarm = '22222222-2222-4222-8222-222222222222'
const invite = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const HOUR = 3_600_000

interface Membership {
  farmId: string
  accountId: string
  role: MemberRole
  revokedAt: number | null
}
interface Invite {
  id: string
  farmId: string
  role: AssignableRole
  createdAt: number
  expiresAt: number
  consumed: boolean
  revoked: boolean
}

/** Mirrors PostgresMembers: owner check, last-owner guard, tombstone, session revocation. */
class MemoryMembers implements MembersStore {
  writes = 0
  readonly memberships: Membership[]
  readonly invites: Invite[]
  private readonly sessions: MemorySessionRepository
  private readonly now: number
  constructor(
    memberships: Membership[],
    invites: Invite[],
    sessions: MemorySessionRepository,
    now: number,
  ) {
    this.memberships = memberships
    this.invites = invites
    this.sessions = sessions
    this.now = now
  }
  private owners(farm: string) {
    return this.memberships.filter(
      (m) => m.farmId === farm && m.role === 'owner' && m.revokedAt === null,
    )
  }
  private isOwner(actor: string, farm: string) {
    return this.owners(farm).some((m) => m.accountId === actor)
  }
  private target(actor: string, farm: string, accountId: string) {
    if (!this.isOwner(actor, farm)) return 'not-found' as const
    const member = this.memberships.find(
      (m) =>
        m.farmId === farm && m.accountId === accountId && m.revokedAt === null,
    )
    if (!member) return 'not-found' as const
    if (member.role === 'owner' && this.owners(farm).length <= 1)
      return 'last-owner' as const
    return member
  }
  async listMembers(actor: string, farm: string) {
    if (!this.isOwner(actor, farm)) return null
    return this.memberships
      .filter((m) => m.farmId === farm && m.revokedAt === null)
      .map((m) => ({
        accountId: m.accountId,
        username: m.accountId,
        role: m.role,
      }))
  }
  async changeRole(
    actor: string,
    farm: string,
    accountId: string,
    role: AssignableRole,
  ) {
    const member = this.target(actor, farm, accountId)
    if (typeof member === 'string') return member
    member.role = role
    this.writes++
    return 'ok' as const
  }
  async removeMember(
    actor: string,
    farm: string,
    accountId: string,
    now: number,
  ) {
    const member = this.target(actor, farm, accountId)
    if (typeof member === 'string') return member
    member.revokedAt = now
    await this.sessions.revokeAccountSessions(accountId)
    this.writes++
    return 'ok' as const
  }
  async listInvites(actor: string, farm: string): Promise<FarmInvite[] | null> {
    if (!this.isOwner(actor, farm)) return null
    return this.invites
      .filter((i) => i.farmId === farm)
      .map((i) => ({
        id: i.id,
        role: i.role,
        createdAt: new Date(i.createdAt).toISOString(),
        expiresAt: new Date(i.expiresAt).toISOString(),
        status: i.revoked
          ? 'revoked'
          : i.consumed
            ? 'consumed'
            : i.expiresAt <= this.now
              ? 'expired'
              : 'pending',
      }))
  }
  async revokeInvite(actor: string, farm: string, id: string) {
    if (!this.isOwner(actor, farm)) return 'not-found' as const
    const found = this.invites.find((i) => i.id === id && i.farmId === farm)
    if (!found) return 'not-found' as const
    if (found.consumed) return 'consumed' as const
    if (!found.revoked) this.writes++
    found.revoked = true
    return 'ok' as const
  }
}

const accounts = ['owner', 'owner2', 'admin', 'viewer', 'outsider']
function fixture() {
  // Every expiry and session time derives from this single clock reading.
  const now = Date.now()
  const sessions = new MemorySessionRepository(
    accounts.map((id) => ({ id, sessionVersion: 0, disabled: false })),
    accounts.map((id) => ({
      id: id + '_session',
      accountId: id,
      accountVersion: 0,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + HOUR,
      revokedAt: null,
    })),
  )
  const member = (accountId: string, role: MemberRole, farm = farmId) => ({
    farmId: farm,
    accountId,
    role,
    revokedAt: null,
  })
  const pending = (n: number, farm = farmId): Invite => ({
    id: invite(n),
    farmId: farm,
    role: 'operator',
    createdAt: now - HOUR,
    expiresAt: now + HOUR,
    consumed: false,
    revoked: false,
  })
  const store = new MemoryMembers(
    [
      member('owner', 'owner'),
      member('admin', 'admin'),
      member('viewer', 'viewer'),
      member('outsider', 'owner', otherFarm),
    ],
    [
      pending(1),
      { ...pending(2), consumed: true },
      { ...pending(3), expiresAt: now - 1 },
      pending(4, otherFarm),
    ],
    sessions,
    now,
  )
  const limits: string[] = []
  let allowed = true
  /** One request: the session id stands in for the sealed cookie. */
  const deps = (session: string | null): MembersDeps => ({
    origin,
    store,
    now: () => now,
    async authenticate() {
      if (session === null) throw new MembersError(401, 'unauthorized')
      const decision = await sessions.authorizeAndTouch(session, now, {
        idleTimeoutMs: HOUR,
      })
      if (!decision.ok) throw new MembersError(401, 'unauthorized')
      return { accountId: decision.accountId }
    },
    async limit(key) {
      limits.push(key)
      if (!allowed) throw new MembersError(429, 'limited')
    },
  })
  return {
    now,
    store,
    sessions,
    limits,
    deps,
    deny: () => (allowed = false),
  }
}
function get(from: string | null = null) {
  return new Request(origin + '/x', {
    headers: from === null ? {} : { origin: from },
  })
}
function post(body?: unknown, from: string | null = origin) {
  return new Request(origin + '/x', {
    method: 'POST',
    headers: {
      ...(from === null ? {} : { origin: from }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const status = (code: number) => (error: unknown) =>
  error instanceof MembersError && error.status === code
/** Every route, as one caller would hit it. */
function everyRoute(deps: MembersDeps, farm = farmId, from: string = origin) {
  return [
    () => listMembers(deps, get(from), farm),
    () => listInvites(deps, get(from), farm),
    () => changeMemberRole(deps, post({ role: 'viewer' }, from), farm, 'admin'),
    () => removeMember(deps, post(undefined, from), farm, 'admin'),
    () => revokeInvite(deps, post(undefined, from), farm, invite(1)),
  ]
}

test('owner lists active members and invites without token material', async () => {
  const f = fixture()
  const { members } = await listMembers(f.deps('owner_session'), get(), farmId)
  assert.deepEqual(
    members.map((m) => [m.accountId, m.role]),
    [
      ['owner', 'owner'],
      ['admin', 'admin'],
      ['viewer', 'viewer'],
    ],
  )
  const { invites } = await listInvites(f.deps('owner_session'), get(), farmId)
  assert.deepEqual(
    invites.map((i) => [i.id, i.status]),
    [
      [invite(1), 'pending'],
      [invite(2), 'consumed'],
      [invite(3), 'expired'],
    ],
  )
  for (const item of invites)
    assert.deepEqual(Object.keys(item).sort(), [
      'createdAt',
      'expiresAt',
      'id',
      'role',
      'status',
    ])
})

test('non-owners get 404 on every route and nothing changes', async () => {
  const f = fixture()
  for (const session of ['admin_session', 'viewer_session', 'outsider_session'])
    for (const call of everyRoute(f.deps(session)))
      await assert.rejects(call, status(404), session)
  // An owner of another farm, an unknown farm and a malformed farm id look the same.
  for (const farm of [otherFarm, '33333333-3333-4333-8333-333333333333', 'x'])
    for (const call of everyRoute(f.deps('owner_session'), farm))
      await assert.rejects(call, status(404), farm)
  assert.equal(f.store.writes, 0)
  assert.equal(f.store.invites[0]!.revoked, false)
})

test('same-origin check runs before authentication on every route', async () => {
  const f = fixture()
  const foreign = 'https://evil.example.invalid'
  let authenticated = 0
  const spy = (session: string): MembersDeps => {
    const deps = f.deps(session)
    return {
      ...deps,
      authenticate: () => (authenticated++, deps.authenticate()),
    }
  }
  for (const session of ['owner_session', 'admin_session'])
    for (const call of everyRoute(spy(session), farmId, foreign))
      await assert.rejects(call, status(403))
  // Mutations need an Origin header; a missing one is refused too.
  const owner = spy('owner_session')
  await assert.rejects(
    removeMember(owner, post(undefined, null), farmId, 'admin'),
    status(403),
  )
  await assert.rejects(
    changeMemberRole(owner, post({ role: 'viewer' }, null), farmId, 'admin'),
    status(403),
  )
  await assert.rejects(
    revokeInvite(owner, post(undefined, null), farmId, invite(1)),
    status(403),
  )
  assert.equal(authenticated, 0)
  assert.equal(f.store.writes, 0)
  assert.deepEqual(f.limits, [])
})

test('requests without a valid session are refused before the store', async () => {
  const f = fixture()
  for (const session of [null, 'forged_session'])
    for (const call of everyRoute(f.deps(session)))
      await assert.rejects(call, status(401))
  assert.equal(f.store.writes, 0)
})

test('the last owner cannot be removed or demoted', async () => {
  const f = fixture()
  const owner = f.deps('owner_session')
  await assert.rejects(
    removeMember(owner, post(), farmId, 'owner'),
    status(409),
  )
  await assert.rejects(
    changeMemberRole(owner, post({ role: 'admin' }), farmId, 'owner'),
    status(409),
  )
  assert.equal(f.store.memberships[0]!.role, 'owner')
  assert.equal(f.store.memberships[0]!.revokedAt, null)
  // The owner's own session survives the refused attempt.
  await listMembers(owner, get(), farmId)

  // With a second owner one of them may go; the one left is the last again.
  f.store.memberships.push({
    farmId,
    accountId: 'owner2',
    role: 'owner',
    revokedAt: null,
  })
  assert.deepEqual(
    await changeMemberRole(
      f.deps('owner2_session'),
      post({ role: 'admin' }),
      farmId,
      'owner',
    ),
    { accountId: 'owner', role: 'admin' },
  )
  const owner2 = f.deps('owner2_session')
  await assert.rejects(
    removeMember(owner2, post(), farmId, 'owner2'),
    status(409),
  )
  await assert.rejects(
    changeMemberRole(owner2, post({ role: 'viewer' }), farmId, 'owner2'),
    status(409),
  )
  // The demoted owner is now a non-owner: 404.
  await assert.rejects(listMembers(owner, get(), farmId), status(404))
})

test('a removed member loses access on the next request', async () => {
  const f = fixture()
  f.store.memberships.push({
    farmId,
    accountId: 'owner2',
    role: 'owner',
    revokedAt: null,
  })
  const removed = f.deps('owner2_session')
  assert.equal((await listMembers(removed, get(), farmId)).members.length, 4)

  await removeMember(f.deps('owner_session'), post(), farmId, 'owner2')
  const tombstone = f.store.memberships.find((m) => m.accountId === 'owner2')!
  assert.equal(tombstone.revokedAt, f.now)
  assert.equal(f.store.memberships.length, 5, 'tombstone is retained')

  // The very next request with the old session is unauthenticated on every route.
  for (const call of everyRoute(removed))
    await assert.rejects(call, status(401))
  // Signing in again does not restore the farm: the membership stays revoked.
  const again: MembersDeps = {
    ...removed,
    authenticate: async () => ({ accountId: 'owner2' }),
  }
  for (const call of everyRoute(again)) await assert.rejects(call, status(404))
  // Removing twice finds no active member, and other members keep their sessions.
  await assert.rejects(
    removeMember(f.deps('owner_session'), post(), farmId, 'owner2'),
    status(404),
  )
  const { members } = await listMembers(f.deps('owner_session'), get(), farmId)
  assert.ok(!members.some((m) => m.accountId === 'owner2'))
  assert.equal(f.sessions.accountForTest('admin')!.sessionVersion, 0)
})

test('role changes accept only non-owner roles for an active member', async () => {
  const f = fixture()
  const owner = f.deps('owner_session')
  assert.deepEqual(
    await changeMemberRole(owner, post({ role: 'operator' }), farmId, 'admin'),
    { accountId: 'admin', role: 'operator' },
  )
  assert.equal(f.store.memberships[1]!.role, 'operator')
  for (const body of [
    { role: 'owner' },
    { role: 'root' },
    { role: 'viewer', extra: 1 },
    {},
    'viewer',
  ])
    await assert.rejects(
      changeMemberRole(owner, post(body), farmId, 'admin'),
      status(400),
    )
  await assert.rejects(
    changeMemberRole(owner, post(), farmId, 'admin'),
    status(415),
  )
  for (const unknown of ['nobody', 'outsider', '../admin'])
    await assert.rejects(
      changeMemberRole(owner, post({ role: 'viewer' }), farmId, unknown),
      status(404),
    )
  assert.equal(f.store.writes, 1)
  // A demotion does not end the member's session.
  assert.equal(f.sessions.accountForTest('admin')!.sessionVersion, 0)
})

test('owner revokes a pending invite; used and foreign invites are refused', async () => {
  const f = fixture()
  const owner = f.deps('owner_session')
  await revokeInvite(owner, post(), farmId, invite(1))
  await revokeInvite(owner, post(), farmId, invite(1))
  assert.equal(f.store.writes, 1, 'revoking twice is idempotent')
  const { invites } = await listInvites(owner, get(), farmId)
  assert.equal(invites.find((i) => i.id === invite(1))!.status, 'revoked')
  await assert.rejects(
    revokeInvite(owner, post(), farmId, invite(2)),
    status(409),
  )
  for (const id of [invite(4), invite(9), 'not-a-uuid'])
    await assert.rejects(revokeInvite(owner, post(), farmId, id), status(404))
  assert.equal(f.store.invites[3]!.revoked, false)
})

test('mutations spend the per-account limit and stop when it is exhausted', async () => {
  const f = fixture()
  const owner = f.deps('owner_session')
  await changeMemberRole(owner, post({ role: 'viewer' }), farmId, 'admin')
  assert.deepEqual(f.limits, ['members:owner'])
  f.deny()
  await assert.rejects(
    removeMember(owner, post(), farmId, 'admin'),
    status(429),
  )
  assert.equal(f.store.memberships[1]!.revokedAt, null)
})

test('routes answer 404 while member management is not configured', async () => {
  const f = fixture()
  const { store: _store, ...rest } = f.deps('owner_session')
  for (const call of everyRoute({ ...rest, store: undefined }))
    await assert.rejects(call, status(404))
})
