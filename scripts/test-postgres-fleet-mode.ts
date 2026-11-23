// Runs only against the runner's disposable, migrated loopback fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import {
  PostgresFleetMode,
  readMemberFleetMode,
} from '../apps/farm/server/storage/fleet-mode-postgres.ts'

const port = Number(process.env.FLEET_MODE_SYNTHETIC_TEST_PORT)
if (
  process.argv.length !== 2 ||
  process.env.FLEET_MODE_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL port required')
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 1,
})
const role = 'fleet_mode_fixture_' + randomUUID().replaceAll('-', '')
const runtime = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: role,
  ssl: false,
  max: 1,
})
let created = false
try {
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_integration_apps`
  created = true
  const owner = 'owner_' + randomUUID().replaceAll('-', '')
  const farm = randomUUID(),
    otherFarm = randomUUID(),
    agent = randomUUID(),
    printer = randomUUID(),
    otherPrinter = randomUUID(),
    app = randomUUID(),
    otherApp = randomUUID()
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  await admin`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, true), (${otherFarm}, true)`
  await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner')`
  await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}, ${farm}, ${'k'.repeat(59)}, ${'f'.repeat(50)})`
  await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}`
  await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${printer}, ${farm}, ${agent}, 'one', 1, ${owner}), (${otherPrinter}, ${farm}, ${agent}, 'two', 1, ${owner})`
  await admin`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${app}, ${farm}, 'app', true, 1, ${owner}), (${otherApp}, ${otherFarm}, 'other', true, 1, ${owner})`
  const grant = async (
    scopes: string[],
    approval = false,
    assigned: string | null = printer,
  ) => {
    const id = randomUUID()
    await admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by) VALUES (${id}, ${app}, ${farm}, ${assigned}, ${scopes}, ${approval}, 1, ${owner})`
    return id
  }
  const good = await grant(['control:extended'])
  const approval = await grant(['control:extended'], true)
  const insufficient = await grant(['printers:read'])
  const wrongPrinter = await grant(['control:extended'], false, otherPrinter)
  const disabled = await grant(['control:extended'])
  await admin`UPDATE farm.integration_app_grants SET disabled_at = 2, disabled_reason = 'revoked' WHERE id = ${disabled}`
  const store = new PostgresFleetMode(runtime)
  assert.deepEqual(await readMemberFleetMode(runtime, farm, printer, owner), {
    mode: 'in-service',
  })
  assert.equal(
    await readMemberFleetMode(runtime, otherFarm, printer, owner),
    null,
  )
  assert.equal(
    await readMemberFleetMode(runtime, farm, printer, 'stranger'),
    null,
  )
  const version = randomUUID()
  const next = {
    mode: 'maintenance' as const,
    previousMode: 'in-service' as const,
    version,
    appId: app,
  }
  const write = (
    grantId: string,
    changes: Partial<typeof next> = {},
    expectedVersion: string | null = null,
  ) =>
    store.compareAndSet({
      printerId: printer,
      grantId,
      expectedVersion,
      next: { ...next, ...changes },
    })
  for (const id of [
    approval,
    insufficient,
    wrongPrinter,
    disabled,
    randomUUID(),
  ])
    assert.equal(await write(id), false)
  assert.equal(await write(good, { appId: otherApp }), false)
  assert.equal(await write(good), true)
  assert.equal((await store.read(printer))?.mode, 'maintenance')
  assert.deepEqual(await readMemberFleetMode(runtime, farm, printer, owner), {
    mode: 'maintenance',
  })
  const restored = {
    mode: 'in-service' as const,
    previousMode: 'maintenance' as const,
    version: randomUUID(),
    appId: app,
  }
  assert.equal(
    await store.compareAndSet({
      printerId: printer,
      grantId: approval,
      expectedVersion: version,
      next: restored,
    }),
    false,
  )
  assert.equal(
    await store.compareAndSet({
      printerId: printer,
      grantId: good,
      expectedVersion: randomUUID(),
      next: restored,
    }),
    false,
  )
  assert.equal(
    await store.compareAndSet({
      printerId: printer,
      grantId: good,
      expectedVersion: version,
      next: restored,
    }),
    true,
  )
  await admin`UPDATE farm.integration_apps SET revoked_at = 3 WHERE id = ${app}`
  assert.equal(
    await store.compareAndSet({
      printerId: printer,
      grantId: good,
      expectedVersion: restored.version,
      next,
    }),
    false,
  )
  console.log('fleet mode authorization and version checks passed')
} finally {
  await runtime.end({ timeout: 3 })
  if (created) await admin`DROP ROLE ${admin(role)}`
  await admin.end({ timeout: 3 })
}
