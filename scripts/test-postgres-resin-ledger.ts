// Synthetic PostgreSQL only. Caller owns the database, migrations (through 0092) and teardown.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  PostgresResinLedger,
  ResinLedgerError,
} from '../apps/farm/server/storage/resin-ledger-postgres.ts'
import { summarizeResinLedger } from '../apps/farm/server/utils/resin-ledger/summary.ts'

const portText = process.env.RESIN_LEDGER_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.RESIN_LEDGER_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  typeof portText !== 'string' ||
  !/^[0-9]{4,5}$/.test(portText) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )

const role = 'resin_fixture_' + randomUUID().replaceAll('-', '')
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
let roleCreated = false
const checks: string[] = []
const check = (name: string) => checks.push(name)
try {
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'farm' AND table_name = 'resin_ledger_entries'`
    )[0]?.n,
    1,
    'Apply migration 0092 before running this fixture',
  )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_resin_ledger`
  roleCreated = true

  const A = randomUUID()
  const B = randomUUID()
  const agentA = randomUUID()
  const agentB = randomUUID()
  const printerA = randomUUID()
  const printerB = randomUUID()
  await admin`INSERT INTO farm.farms (id) VALUES (${A}::uuid), (${B}::uuid)`
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const who = async (farm: string, name: string, member: string) => {
    const id = `${name}_${suffix}`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${id},${id},0,100,100,10000000)`
    await admin`INSERT INTO farm.memberships (farm_id,account_id,role) VALUES (${farm}::uuid,${id},${member})`
    return id
  }
  const owner = await who(A, 'owner', 'owner')
  const operator = await who(A, 'operator', 'operator')
  const viewer = await who(A, 'viewer', 'viewer')
  const other = await who(B, 'other', 'owner')
  for (const [farm, agent, printer, by] of [
    [A, agentA, printerA, owner],
    [B, agentB, printerB, other],
  ] as const) {
    await admin`INSERT INTO farm.connector_enrollments (agent_id,farm_id,public_key_spki,fingerprint) VALUES (${agent}::uuid,${farm}::uuid,${'a'.repeat(59)},${'b'.repeat(50)})`
    await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${agent}::uuid`
    await admin`INSERT INTO farm.printer_assignments (id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${printer}::uuid,${farm}::uuid,${agent}::uuid,'p1',100,${by})`
  }

  let now = 1000
  const ledger = new PostgresResinLedger(runtime, () => ++now)
  const auth = (farmId: string, session: string) => ({
    farmId,
    sessionRecordId: session,
    policy: { idleTimeoutMs: 600_000 },
  })
  const list = async (farmId: string, session: string, key = 'p1') => {
    const rows = await ledger.run(auth(farmId, session), {
      op: 'list',
      printerKey: key,
    })
    assert.ok(Array.isArray(rows))
    return rows
  }
  const write = (farmId: string, session: string, entry: never, key = 'p1') =>
    ledger.run(auth(farmId, session), { op: 'record', printerKey: key, entry })

  // Operators record vats, bottles, volumes and counters; unknown stays NULL.
  await write(A, owner, {
    kind: 'vat',
    name: 'Cuba A',
    source: 'manual',
  } as never)
  await write(A, operator, {
    kind: 'bottle',
    name: 'B1',
    volumeMl: null,
    source: 'manual',
  } as never)
  await write(A, operator, {
    kind: 'volume',
    target: 'vat',
    name: 'Cuba A',
    volumeMl: 250,
    source: 'manual',
  } as never)
  await write(A, owner, { kind: 'film', layers: 12, source: 'manual' } as never)
  await write(A, owner, { kind: 'lcd', hours: 3.5, source: 'manual' } as never)
  const rows = await list(A, viewer)
  assert.equal(rows.length, 5)
  const summary = summarizeResinLedger(rows)
  assert.deepEqual(summary.bottles, [
    {
      name: 'B1',
      volumeMl: null,
      source: 'manual',
      recordedAt: summary.bottles[0]!.recordedAt,
    },
  ])
  assert.equal(summary.vatVolumeMl?.value, 250)
  assert.equal(summary.film?.value, 12)
  assert.equal(summary.lcd?.value, 3.5)
  assert.equal(
    (
      await admin`SELECT volume_ml FROM farm.resin_ledger_entries WHERE farm_id=${A}::uuid AND kind='bottle'`
    )[0]?.volume_ml,
    null,
  )
  check('records every kind; unknown bottle volume stored as NULL')

  // Authorization: viewers read but cannot write; other farms see nothing.
  await assert.rejects(
    write(A, viewer, { kind: 'film', layers: 1, source: 'manual' } as never),
    (e) => e instanceof ResinLedgerError && e.status === 403,
  )
  await assert.rejects(
    list(A, other),
    (e) => e instanceof ResinLedgerError && e.status === 404,
  )
  await assert.rejects(
    list(B, owner),
    (e) => e instanceof ResinLedgerError && e.status === 404,
  )
  assert.equal((await list(B, other)).length, 0)
  await assert.rejects(
    list(A, owner, 'unknown-printer'),
    (e) => e instanceof ResinLedgerError && e.status === 404,
  )
  check('viewer read-only; cross-farm and unknown printer are not found')

  // Provenance: accounts cannot claim reported; the table enforces it too.
  await assert.rejects(
    write(A, owner, { kind: 'film', layers: 1, source: 'reported' } as never),
    (e) => e instanceof ResinLedgerError && e.status === 400,
  )
  await assert.rejects(
    runtime`INSERT INTO farm.resin_ledger_entries (farm_id,id,printer_id,kind,layers,source,recorded_at,recorded_by) VALUES (${A}::uuid,${randomUUID()}::uuid,${printerA}::uuid,'film',1,'reported',1,${owner})`,
  )
  await assert.rejects(
    runtime`INSERT INTO farm.resin_ledger_entries (farm_id,id,printer_id,kind,source,recorded_at,recorded_by) VALUES (${A}::uuid,${randomUUID()}::uuid,${printerA}::uuid,'film','manual',1,${owner})`,
  )
  await assert.rejects(
    runtime`INSERT INTO farm.resin_ledger_entries (farm_id,id,printer_id,kind,layers,source,recorded_at,recorded_by) VALUES (${A}::uuid,${randomUUID()}::uuid,${printerB}::uuid,'film',1,'manual',1,${owner})`,
  )
  check(
    'provenance and per-kind constraints; composite printer FK rejects another farm',
  )

  // Append-only for the runtime role.
  await assert.rejects(runtime`UPDATE farm.resin_ledger_entries SET layers=0`)
  await assert.rejects(runtime`DELETE FROM farm.resin_ledger_entries`)
  check('runtime role is append-only')
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
