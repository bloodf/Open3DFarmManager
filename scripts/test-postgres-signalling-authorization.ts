// Explicit disposable loopback fixture, official contiguous migrations through 0017.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import {
  testPostgresSignallingAuthorization,
  signallingReaderFixtureConfig,
} from '../tests/helpers/postgres-signalling-authorization-integration.ts'
import { PostgresSignallingAuthorization } from '../apps/farm/server/storage/postgres-signalling-authorization.ts'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
} from '../packages/farm-protocol/src/browser-device-proof.ts'
const text = process.env.SIGNALLING_READER_SYNTHETIC_TEST_PORT,
  port = Number(text)
if (
  process.argv.length !== 2 ||
  process.env.SIGNALLING_READER_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !text ||
  !/^[0-9]{4,5}$/.test(text) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL port required; no arguments accepted',
  )
const role = 'signalling_reader_fixture_' + randomUUID().replaceAll('-', '')
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  ssl: false as const,
  max: 6,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const runtime = postgres({
  ...options,
  username: role,
  connection: { application_name: role },
})
let created = false
let checks: string[] = []
try {
  assert.equal(
    (await admin`SELECT current_database() AS db,current_user AS actor`)[0]?.db,
    'fixture',
  )
  assert.equal((await admin`SELECT current_user AS actor`)[0]?.actor, 'fixture')
  const catalog = (await loadMigrationCatalog()).slice(0, 17)
  assert.equal(catalog.length, 17)
  assert.equal(catalog[16]?.id, '0017_signalling_authorization')
  const history =
    await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), 17)
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_signalling_reader`
  created = true
  const verifyPath = process.env.SIGNALLING_READER_VERIFY_RESTART
  if (verifyPath) {
    const raw: unknown = JSON.parse(await readFile(verifyPath, 'utf8'))
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 3 ||
      !('v' in raw) ||
      raw.v !== 1 ||
      !('scope' in raw) ||
      !raw.scope ||
      typeof raw.scope !== 'object' ||
      Array.isArray(raw.scope) ||
      Object.keys(raw.scope).length !== 4 ||
      !('revokedAt' in raw) ||
      typeof raw.revokedAt !== 'string' ||
      !/^[0-9]{1,16}$/.test(raw.revokedAt)
    )
      throw new Error('Invalid restart fixture')
    const scope = raw.scope
    if (
      !('sessionRecordId' in scope) ||
      !('farmId' in scope) ||
      !('agentId' in scope) ||
      !('keyId' in scope)
    )
      throw new Error('Invalid restart fixture scope')
    const fixture = {
      revokedAt: raw.revokedAt,
      scope: {
        sessionRecordId: BrowserDeviceTextId.parse(scope.sessionRecordId),
        farmId: BrowserDeviceUuid.parse(scope.farmId),
        agentId: BrowserDeviceUuid.parse(scope.agentId),
        keyId: BrowserDeviceUuid.parse(scope.keyId),
      },
    }
    const saved = Date.now
    try {
      Date.now = () => 1
      assert.deepEqual(
        await new PostgresSignallingAuthorization(
          runtime,
          signallingReaderFixtureConfig,
        ).authorize(fixture.scope),
        { ok: false, reason: 'denied' },
      )
    } finally {
      Date.now = saved
    }
    assert.equal(
      (
        await admin`SELECT revoked_at::text AS at FROM farm.account_sessions WHERE id=${fixture.scope.sessionRecordId}`
      )[0]?.at,
      fixture.revokedAt,
    )
    checks = [
      'terminal expiry survives actual database restart/new process and regressed application clock',
    ]
  } else
    checks = await testPostgresSignallingAuthorization(
      admin,
      runtime,
      role,
      process.env.SIGNALLING_READER_RESTART_FIXTURE,
    )
} finally {
  await runtime.end({ timeout: 3 })
  try {
    if (created) await admin`DROP ROLE ${admin(role)}`
  } finally {
    await admin.end({ timeout: 3 })
  }
}
console.log(JSON.stringify({ ok: true, checks }, null, 2))
