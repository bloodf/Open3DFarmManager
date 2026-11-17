// Synthetic PostgreSQL only. Caller owns the database, migrations (through 0038) and teardown.
// Owner-issued reset links: cross-farm takeover refused at issue and redemption,
// and a concurrent membership insert serializes behind the issuing transaction.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { PostgresPasswordReset } from '../apps/farm/server/storage/postgres-password-reset.ts'

const portText = process.env.PASSWORD_RESET_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.PASSWORD_RESET_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const role = 'reset_fixture_' + randomUUID().replaceAll('-', '')
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  ssl: false as const,
  max: 4,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const runtime = postgres({ ...options, username: role })
const digest = (c: string) => c.repeat(64)
let roleCreated = false
const checks: string[] = []
try {
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'farm' AND table_name = 'password_reset_tokens' AND column_name = 'owner_farm_id'`
    )[0]?.n,
    1,
    'Apply migration 0038 before running this fixture',
  )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_password_reset`
  roleCreated = true
  const farmA = randomUUID()
  const farmB = randomUUID()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const ids = Object.fromEntries(
    ['alice', 'bob', 'carol', 'dave'].map((n) => [n, n + '_' + suffix]),
  ) as Record<'alice' | 'bob' | 'carol' | 'dave', string>
  await admin`INSERT INTO farm.farms (id) VALUES (${farmA}), (${farmB})`
  for (const id of Object.values(ids)) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${id}, ${id}, 'hash:original')`
  }
  const join = (farm: string, id: string, r: string) =>
    admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${id}, ${r})`
  await join(farmA, ids.alice, 'owner')
  await join(farmB, ids.bob, 'owner')
  await join(farmA, ids.bob, 'viewer')
  await join(farmA, ids.carol, 'viewer')
  await join(farmA, ids.dave, 'viewer')
  const store = new PostgresPasswordReset(runtime)
  const tokenCount = async (id: string) =>
    (
      await admin`SELECT count(*)::int AS n FROM farm.password_reset_tokens WHERE account_id = ${id}`
    )[0]!.n as number
  const passwordHash = async (id: string) =>
    (
      await admin`SELECT password_hash FROM farm.password_credentials WHERE account_id = ${id}`
    )[0]!.password_hash as string

  // Reviewer repro: bob owns farm B and joined farm A; alice may not reset him.
  assert.deepEqual(
    await store.issueForMember(ids.alice, farmA, ids.bob, digest('1')),
    { refused: 'shared-account' },
  )
  assert.equal(await tokenCount(ids.bob), 0)
  checks.push('cross-farm issue refused')

  assert.deepEqual(
    await store.issueForMember(ids.alice, farmA, ids.alice, digest('2')),
    { refused: 'self' },
  )
  assert.equal(await tokenCount(ids.alice), 0)
  checks.push('self issue refused')

  const issued = await store.issueForMember(
    ids.alice,
    farmA,
    ids.carol,
    digest('3'),
  )
  assert.ok(issued && !('refused' in issued))
  assert.equal(issued.username, ids.carol)
  assert.equal(
    (
      await admin`SELECT owner_farm_id FROM farm.password_reset_tokens WHERE account_id = ${ids.carol}`
    )[0]!.owner_farm_id,
    farmA,
  )
  assert.equal(await store.consume(ids.carol, digest('3'), 'hash:new'), true)
  assert.equal(await passwordHash(ids.carol), 'hash:new')
  checks.push('sole-member issue and redemption allowed')

  const later = await store.issueForMember(
    ids.alice,
    farmA,
    ids.dave,
    digest('4'),
  )
  assert.ok(later && !('refused' in later))
  await join(farmB, ids.dave, 'operator')
  assert.equal(await store.consume(ids.dave, digest('4'), 'hash:new'), false)
  assert.equal(await passwordHash(ids.dave), 'hash:original')
  assert.equal(await tokenCount(ids.dave), 0)
  checks.push('redemption refused after joining another farm')

  // A membership insert in flight holds KEY SHARE on the account row, so the
  // issuing transaction cannot read a stale membership set: it waits and times out.
  const carolNew = 'erin_' + suffix
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${carolNew})`
  await admin`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${carolNew}, ${carolNew}, 'hash:original')`
  await join(farmA, carolNew, 'viewer')
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let inserted!: () => void
  const ready = new Promise<void>((resolve) => (inserted = resolve))
  const racing = admin.begin(async (tx) => {
    await tx`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farmB}::uuid, ${carolNew}, 'viewer')`
    inserted()
    await held
  })
  await ready
  await assert.rejects(
    store.issueForMember(ids.alice, farmA, carolNew, digest('5')),
    /lock timeout/,
  )
  release()
  await racing
  assert.deepEqual(
    await store.issueForMember(ids.alice, farmA, carolNew, digest('5')),
    { refused: 'shared-account' },
  )
  assert.equal(await tokenCount(carolNew), 0)
  checks.push('concurrent membership insert serializes with issue')

  // Self-service reissue clears the farm binding.
  assert.equal(await store.issue(ids.alice, digest('6')), true)
  assert.equal(
    (
      await admin`SELECT owner_farm_id FROM farm.password_reset_tokens WHERE account_id = ${ids.alice}`
    )[0]!.owner_farm_id,
    null,
  )
  checks.push('self-service token unbound')
} finally {
  try {
    await runtime.end({ timeout: 3 })
  } finally {
    try {
      if (roleCreated) await admin`DROP ROLE ${admin(role)}`
    } finally {
      await admin.end({ timeout: 3 })
    }
  }
}
console.log(JSON.stringify({ result: 'passed', checks }))
