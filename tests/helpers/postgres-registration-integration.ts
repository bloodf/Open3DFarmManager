import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresRegistration } from '../../apps/farm/server/storage/postgres-registration.ts'
import { PostgresOidc } from '../../apps/farm/server/storage/postgres-oidc.ts'
import { PostgresSignInRules } from '../../apps/farm/server/storage/sign-in-rules.ts'

const hash = 'synthetic-registration-password-hash-00000'
const digest = (c: string) => c.repeat(64)

/** Disposable migrated database only. Caller owns pools, roles and database teardown. */
export async function testPostgresRegistration(admin: Sql, runtime: Sql) {
  const store = new PostgresRegistration(runtime)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)

  // Bootstrap: exactly one of N concurrent attempts wins, and only on an empty instance.
  const existing = (
    await admin`SELECT count(*)::int AS n FROM farm.session_accounts`
  )[0]?.n as number
  const owner = 'owner_' + suffix
  const race = await Promise.all(
    [1, 2, 3, 4].map((i) => store.bootstrap(`${owner}_${i}`, hash)),
  )
  assert.equal(
    race.filter(Boolean).length,
    existing === 0 ? 1 : 0,
    'bootstrap must create exactly one owner on an empty instance',
  )
  if (existing !== 0)
    throw new Error(
      'Registration fixture requires an empty disposable database',
    )
  const ownerRow = (
    await admin`SELECT c.account_id AS id, m.farm_id AS farm FROM farm.password_credentials c JOIN farm.memberships m ON m.account_id = c.account_id WHERE c.username LIKE ${owner + '_%'}`
  )[0]!
  const members =
    await admin`SELECT role FROM farm.memberships WHERE farm_id = ${ownerRow.farm}`
  assert.deepEqual(
    members.map((m) => m.role),
    ['owner'],
  )
  assert.equal(await store.bootstrap('another_' + suffix, hash), false)

  // Google sign-in never consumes an admin or mismatched bound invitation.
  const google = new PostgresOidc(runtime)
  const rules = new PostgresSignInRules(runtime)
  const googleBase = {
    issuer: 'https://accounts.google.com',
    email: 'member@example.test',
    passwordHash: hash,
  }
  assert.deepEqual(await rules.access(ownerRow.id, ownerRow.farm), {
    mode: 'invite-only',
    allowedDomains: [],
  })
  assert.equal(await rules.access('nobody', ownerRow.farm), null)
  await store.createInvite(
    ownerRow.id,
    ownerRow.farm,
    'admin',
    digest('8'),
    60_000,
    googleBase.email,
  )
  assert.equal(
    await google.signInGoogle({
      ...googleBase,
      subject: 'admin-' + suffix,
      username: 'admin_' + suffix,
      inviteDigest: digest('8'),
    }),
    null,
  )
  await store.createInvite(
    ownerRow.id,
    ownerRow.farm,
    'viewer',
    digest('9'),
    60_000,
    'other@example.test',
  )
  assert.equal(
    await google.signInGoogle({
      ...googleBase,
      subject: 'wrong-' + suffix,
      username: 'wrong_' + suffix,
      inviteDigest: digest('9'),
    }),
    null,
  )
  assert.equal(
    await store.register(digest('9'), 'bound_' + suffix, hash),
    false,
  )
  await store.createInvite(
    ownerRow.id,
    ownerRow.farm,
    'operator',
    digest('0'),
    60_000,
    googleBase.email,
  )
  const joined = await google.signInGoogle({
    ...googleBase,
    subject: 'google-' + suffix,
    username: 'google_' + suffix,
    inviteDigest: digest('0'),
  })
  assert.ok(joined?.created)
  const invited =
    await admin`SELECT role FROM farm.memberships WHERE account_id = ${joined.accountId} AND farm_id = ${ownerRow.farm}`
  assert.equal(invited[0]?.role, 'operator')
  assert.equal(
    await google.signInGoogle({
      ...googleBase,
      subject: 'replay-' + suffix,
      username: 'replay_' + suffix,
      inviteDigest: digest('0'),
    }),
    null,
  )
  await rules.access(ownerRow.id, ownerRow.farm, {
    mode: 'allowed-domains',
    allowedDomains: ['example.test'],
  })
  const domainUser = await google.signInGoogle({
    ...googleBase,
    subject: 'domain-' + suffix,
    username: 'domain_' + suffix,
  })
  assert.ok(domainUser?.created)
  const domainMember =
    await admin`SELECT role FROM farm.memberships WHERE account_id = ${domainUser.accountId} AND farm_id = ${ownerRow.farm}`
  assert.equal(domainMember[0]?.role, 'viewer')
  const secondFarm = randomUUID()
  await admin`INSERT INTO farm.farms (id) VALUES (${secondFarm})`
  await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${secondFarm}, ${ownerRow.id}, 'owner')`
  await rules.access(ownerRow.id, secondFarm, {
    mode: 'allowed-domains',
    allowedDomains: ['example.test'],
  })
  const returned = await google.signInGoogle({
    ...googleBase,
    subject: 'domain-' + suffix,
  })
  assert.deepEqual(returned, {
    accountId: domainUser.accountId,
    created: false,
  })
  const memberships =
    await admin`SELECT role FROM farm.memberships WHERE account_id = ${domainUser.accountId} ORDER BY farm_id`
  assert.deepEqual(
    memberships.map((row) => row.role),
    ['viewer', 'viewer'],
  )
  await rules.access(ownerRow.id, ownerRow.farm, {
    mode: 'link-only',
    allowedDomains: [],
  })
  await store.createInvite(
    ownerRow.id,
    ownerRow.farm,
    'viewer',
    digest('4'),
    60_000,
    googleBase.email,
  )
  assert.equal(
    await google.signInGoogle({
      ...googleBase,
      subject: 'link-only-' + suffix,
      username: 'linkonly_' + suffix,
      inviteDigest: digest('4'),
    }),
    null,
  )
  assert.equal(
    await google.signInGoogle({
      ...googleBase,
      email: 'outsider@other.test',
      subject: 'outside-' + suffix,
      username: 'outside_' + suffix,
    }),
    null,
  )

  // Invites: only an active owner may create; the role cannot be owner (DB CHECK).
  const farm = ownerRow.farm as string
  const expires = await store.createInvite(
    ownerRow.id,
    farm,
    'operator',
    digest('a'),
    60_000,
  )
  assert.ok(expires instanceof Date)
  assert.equal(
    await store.createInvite('nobody', farm, 'viewer', digest('b'), 60_000),
    null,
  )
  await assert.rejects(
    runtime.begin(
      (tx) =>
        tx`INSERT INTO farm.account_invites (farm_id, role, digest, created_by, expires_at) VALUES (${farm}, 'owner', ${digest('c')}, ${ownerRow.id}, clock_timestamp() + interval '1 hour')`,
    ),
  )
  await assert.rejects(
    store.createInvite(
      ownerRow.id,
      farm,
      'viewer',
      digest('d'),
      8 * 24 * 3600_000,
    ),
    'TTL above seven days is rejected by the database',
  )

  // Registration: single use under concurrency, membership role from the invite.
  const newcomers = [`new_a_${suffix}`, `new_b_${suffix}`]
  const outcomes = await Promise.all(
    newcomers.map((name) => store.register(digest('a'), name, hash)),
  )
  assert.deepEqual(outcomes.sort(), [false, true])
  const created =
    await admin`SELECT c.username, m.role, m.farm_id FROM farm.password_credentials c JOIN farm.memberships m ON m.account_id = c.account_id WHERE c.username = ANY(${newcomers})`
  assert.equal(created.length, 1)
  assert.equal(created[0]?.role, 'operator')
  assert.equal(created[0]?.farm_id, farm)
  assert.equal(
    await store.register(digest('a'), `new_c_${suffix}`, hash),
    false,
  )

  // A taken username must not burn the invite or leave an orphan account behind.
  await store.createInvite(ownerRow.id, farm, 'viewer', digest('e'), 60_000)
  const before = (
    await admin`SELECT count(*)::int AS n FROM farm.session_accounts`
  )[0]?.n
  assert.equal(
    await store.register(digest('e'), created[0]!.username, hash),
    false,
  )
  assert.equal(
    (await admin`SELECT count(*)::int AS n FROM farm.session_accounts`)[0]?.n,
    before,
  )
  assert.equal(await store.register(digest('e'), `new_d_${suffix}`, hash), true)

  // Expired and unknown invites; consumed invites are immutable.
  await store.createInvite(ownerRow.id, farm, 'viewer', digest('f'), 60_000)
  await admin`ALTER TABLE farm.account_invites DISABLE TRIGGER account_invite_guard`
  await admin`UPDATE farm.account_invites SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE digest = ${digest('f')}`
  await admin`ALTER TABLE farm.account_invites ENABLE TRIGGER account_invite_guard`
  assert.equal(
    await store.register(digest('f'), `new_e_${suffix}`, hash),
    false,
  )
  assert.equal(
    await store.register(digest('9'), `new_f_${suffix}`, hash),
    false,
  )
  await assert.rejects(
    admin`UPDATE farm.account_invites SET consumed_by = NULL, consumed_at = NULL WHERE digest = ${digest('a')}`,
  )
  await assert.rejects(admin`DELETE FROM farm.account_invites`)

  // An invite minted by an owner who is later revoked or disabled is dead.
  await store.createInvite(ownerRow.id, farm, 'viewer', digest('1'), 60_000)
  await store.createInvite(ownerRow.id, farm, 'viewer', digest('2'), 60_000)
  await admin`UPDATE farm.session_accounts SET disabled = true WHERE id = ${ownerRow.id}`
  assert.equal(
    await store.register(digest('1'), `new_g_${suffix}`, hash),
    false,
  )
  await admin`UPDATE farm.session_accounts SET disabled = false WHERE id = ${ownerRow.id}`
  assert.equal(await store.register(digest('2'), `new_h_${suffix}`, hash), true)
  await store.createInvite(ownerRow.id, farm, 'viewer', digest('3'), 60_000)
  // A revoked owner can no longer invite, and earlier invites stop working.
  await admin`UPDATE farm.memberships SET revoked_at = 1 WHERE account_id = ${ownerRow.id}`
  assert.equal(
    await store.register(digest('3'), `new_i_${suffix}`, hash),
    false,
  )
  assert.equal(
    await store.createInvite(ownerRow.id, farm, 'viewer', digest('7'), 60_000),
    null,
  )
  return [
    'bootstrap single winner and closed afterwards',
    'invite creation owner-only, no owner role, bounded ttl',
    'invite single use under concurrency with invite role',
    'username conflict keeps invite and leaves no orphan',
    'expired and unknown invites rejected, consumed invites immutable',
    'revoked or disabled owner cannot invite and their invites are dead',
  ]
}
