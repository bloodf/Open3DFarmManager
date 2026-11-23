import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresMembers } from '../../apps/farm/server/storage/postgres-members.ts'
import { PostgresRegistration } from '../../apps/farm/server/storage/postgres-registration.ts'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'

const hash = 'synthetic-members-password-hash-0000000000'
const digest = (c: string) => c.repeat(64)

/** Disposable migrated empty database only. Caller owns pools, roles and teardown. */
export async function testPostgresMembers(admin: Sql, runtime: Sql) {
  const registration = new PostgresRegistration(runtime)
  const members = new PostgresMembers(runtime)
  const sessions = new PostgresSessionRepository(runtime)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const now = Date.now()

  assert.equal(await registration.bootstrap('owner_' + suffix, hash), true)
  const row = (
    await admin`SELECT m.account_id AS id, m.farm_id AS farm FROM farm.memberships m`
  )[0]!
  const owner = row.id as string
  const farm = row.farm as string
  const join = async (name: string, c: string, role: 'admin' | 'viewer') => {
    await registration.createInvite(owner, farm, role, digest(c), 60_000)
    assert.equal(await registration.register(digest(c), name, hash), true)
    return (
      await admin`SELECT account_id FROM farm.password_credentials WHERE username = ${name}`
    )[0]!.account_id as string
  }
  const adminMember = await join('admin_' + suffix, 'a', 'admin')
  const viewer = await join('viewer_' + suffix, 'b', 'viewer')
  const role = async (id: string) =>
    (
      await admin`SELECT role, revoked_at FROM farm.memberships WHERE farm_id = ${farm} AND account_id = ${id}`
    )[0]!

  // Listing and every change are owner-only; unknown farms look the same.
  const listed = await members.listMembers(owner, farm)
  assert.deepEqual(listed?.map((m) => m.role).sort(), [
    'admin',
    'owner',
    'viewer',
  ])
  assert.ok(listed?.every((m) => typeof m.username === 'string'))
  const elsewhere = randomUUID()
  assert.equal(await members.listMembers(adminMember, farm), null)
  assert.equal(await members.listMembers(owner, elsewhere), null)
  assert.equal(await members.listInvites(adminMember, farm), null)
  assert.equal(
    await members.changeRole(adminMember, farm, viewer, 'operator'),
    'not-found',
  )
  assert.equal(
    await members.removeMember(adminMember, farm, viewer, now),
    'not-found',
  )
  assert.equal(
    await members.removeMember(owner, elsewhere, viewer, now),
    'not-found',
  )
  assert.equal((await role(viewer)).role, 'viewer')

  // The last owner can be neither demoted nor removed.
  assert.equal(
    await members.changeRole(owner, farm, owner, 'admin'),
    'last-owner',
  )
  assert.equal(
    await members.removeMember(owner, farm, owner, now),
    'last-owner',
  )
  assert.equal((await role(owner)).role, 'owner')
  assert.equal((await role(owner)).revoked_at, null)

  assert.equal(await members.changeRole(owner, farm, viewer, 'operator'), 'ok')
  assert.equal((await role(viewer)).role, 'operator')

  // Removal tombstones the membership and ends the member's live session.
  const sessionId = 'members_' + suffix
  await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${sessionId}, ${viewer}, 0, ${now}, ${now}, ${now + 3_600_000})`
  const policy = { idleTimeoutMs: 3_600_000 }
  assert.equal(
    (await sessions.authorizeAndTouch(sessionId, now, policy)).ok,
    true,
  )
  assert.equal(await members.removeMember(owner, farm, viewer, now), 'ok')
  assert.equal(Number((await role(viewer)).revoked_at), now)
  assert.deepEqual(await sessions.authorizeAndTouch(sessionId, now, policy), {
    ok: false,
    reason: 'revoked',
  })
  assert.equal(
    await members.removeMember(owner, farm, viewer, now),
    'not-found',
  )
  assert.equal(
    await members.changeRole(owner, farm, viewer, 'viewer'),
    'not-found',
  )
  assert.equal((await members.listMembers(owner, farm))?.length, 2)

  // Two owners demoting each other at once: exactly one wins, one owner remains.
  const second = 'second_' + suffix
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${second})`
  await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${second}, 'owner')`
  const race = await Promise.all([
    members.changeRole(owner, farm, second, 'admin'),
    members.changeRole(second, farm, owner, 'admin'),
  ])
  assert.equal(race.filter((r) => r === 'ok').length, 1, race.join())
  const owners =
    await admin`SELECT account_id FROM farm.memberships WHERE farm_id = ${farm} AND role = 'owner' AND revoked_at IS NULL`
  assert.equal(owners.length, 1)
  const survivor = owners[0]!.account_id as string
  assert.equal(
    await members.removeMember(survivor, farm, survivor, now),
    'last-owner',
  )

  // Invites: listed without digest, revoked once, and a revoked invite cannot register.
  // Invites are honoured only while their creator is an active owner.
  if (survivor !== owner) {
    await admin`ALTER TABLE farm.memberships DISABLE TRIGGER membership_lifecycle`
    await admin`UPDATE farm.memberships SET role = 'owner' WHERE farm_id = ${farm} AND account_id = ${owner}`
    await admin`ALTER TABLE farm.memberships ENABLE TRIGGER membership_lifecycle`
  }
  await registration.createInvite(owner, farm, 'viewer', digest('c'), 60_000)
  await registration.createInvite(owner, farm, 'viewer', digest('d'), 60_000)
  const invites = (await members.listInvites(owner, farm))!
  assert.equal(invites.length, 4)
  assert.deepEqual(invites.map((i) => i.status).sort(), [
    'consumed',
    'consumed',
    'pending',
    'pending',
  ])
  assert.ok(invites.every((i) => !('digest' in i)))
  const idOf = async (c: string) =>
    (
      await admin`SELECT id FROM farm.account_invites WHERE digest = ${digest(c)}`
    )[0]!.id as string
  const pending = await idOf('c')
  assert.equal(
    await members.revokeInvite(adminMember, farm, pending),
    'not-found',
  )
  assert.equal(
    await members.revokeInvite(owner, elsewhere, pending),
    'not-found',
  )
  assert.equal(
    await members.revokeInvite(owner, farm, randomUUID()),
    'not-found',
  )
  assert.equal(await members.revokeInvite(owner, farm, pending), 'ok')
  assert.equal(await members.revokeInvite(owner, farm, pending), 'ok')
  assert.equal(
    await registration.register(digest('c'), 'late_' + suffix, hash),
    false,
  )
  assert.equal(
    await members.revokeInvite(owner, farm, await idOf('a')),
    'consumed',
  )
  assert.equal(
    (await members.listInvites(owner, farm))!.find((i) => i.id === pending)
      ?.status,
    'revoked',
  )
  // Revocation is terminal, and the other invite still works.
  await assert.rejects(
    admin`UPDATE farm.account_invites SET revoked_at = NULL, revoked_by = NULL WHERE id = ${pending}`,
  )
  await assert.rejects(
    admin`UPDATE farm.account_invites SET consumed_at = clock_timestamp(), consumed_by = ${owner} WHERE id = ${pending}`,
  )
  assert.equal(
    await registration.register(digest('d'), 'kept_' + suffix, hash),
    true,
  )
  return [
    'member and invite listing owner-only',
    'last owner cannot be removed or demoted',
    'removal tombstones membership and revokes the live session',
    'concurrent owner demotions leave exactly one owner',
    'invite revocation owner-only, idempotent, terminal and blocks registration',
  ]
}
