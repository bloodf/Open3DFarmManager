// Caller owns the isolated restart and private synthetic fixture cleanup. Never log tokens.
import assert from 'node:assert/strict'
import { readFile, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { TelemetryProofCompletion } from '../packages/farm-protocol/src/telemetry-proof.ts'
import { PostgresConnectorCredentialAcceptance } from '../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import { prepareTelemetryOperation } from '../apps/farm/server/services/telemetry-operation.ts'
const port = Number(process.env.ATOMIC_TELEMETRY_SYNTHETIC_TEST_PORT),
  path = process.env.ATOMIC_TELEMETRY_RESTART_FIXTURE
if (
  process.argv.length !== 2 ||
  process.env.ATOMIC_TELEMETRY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !path
)
  throw new Error('Disposable loopback fixture required')
const metadata = await lstat(path)
if (
  !metadata.isFile() ||
  metadata.size > 196608 ||
  (metadata.mode & 0o077) !== 0
)
  throw new Error('Bounded private restart fixture required')
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const value: unknown = parseBoundedJson(
  new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)),
  { maxBytes: 196608, maxDepth: 5, maxValues: 200, maxStringChars: 98304 },
)
if (
  !object(value) ||
  !object(value.config) ||
  Object.keys(value).sort().join(',') !==
    'body,config,consumed,databaseStarted,expectedCount,now,pending,publicKeySpki,seedPid' ||
  Object.keys(value.config).sort().join(',') !==
    'audience,issuer,kid,origin,proofTtlMs,purpose,ttlSeconds' ||
  typeof value.body !== 'string' ||
  typeof value.expectedCount !== 'number' ||
  !Number.isSafeInteger(value.expectedCount) ||
  value.expectedCount < 1 ||
  value.expectedCount > 100 ||
  typeof value.now !== 'number' ||
  !Number.isSafeInteger(value.now) ||
  value.now < 0 ||
  typeof value.seedPid !== 'number' ||
  typeof value.databaseStarted !== 'string' ||
  typeof value.publicKeySpki !== 'string' ||
  typeof value.config.issuer !== 'string' ||
  typeof value.config.audience !== 'string' ||
  typeof value.config.origin !== 'string' ||
  typeof value.config.kid !== 'string' ||
  value.config.purpose !== 'telemetry-ingestion' ||
  typeof value.config.ttlSeconds !== 'number' ||
  typeof value.config.proofTtlMs !== 'number'
)
  throw new Error('Invalid synthetic restart fixture')
const pending = TelemetryProofCompletion.parse(value.pending),
  consumed = TelemetryProofCompletion.parse(value.consumed),
  body = Buffer.from(value.body, 'base64url')
assert.equal(body.toString('base64url'), value.body)
const operation = prepareTelemetryOperation(body)
const fixtureNow = value.now
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 2,
  ssl: false,
  connect_timeout: 3,
})
const role = 'telemetry_restart_' + randomUUID().replaceAll('-', '')
let runtime: ReturnType<typeof postgres> | undefined,
  created = false
try {
  const identity = (
    await admin`SELECT current_user AS username,current_database() AS database,pg_postmaster_start_time()::text AS started`
  )[0]
  assert.equal(identity?.username, 'fixture')
  assert.equal(identity?.database, 'fixture')
  assert.notEqual(identity.started, value.databaseStarted)
  assert.notEqual(process.pid, value.seedPid)
  const catalog = (await loadMigrationCatalog()).slice(0, 16),
    history =
      await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), 16)
  const publicKey = await crypto.subtle.importKey(
    'spki',
    Buffer.from(value.publicKeySpki, 'base64url'),
    'Ed25519',
    true,
    ['verify'],
  )
  const config: ConstructorParameters<
    typeof PostgresConnectorCredentialAcceptance
  >[1] = {
    issuer: value.config.issuer,
    audience: value.config.audience,
    origin: value.config.origin,
    purpose: 'telemetry-ingestion',
    ttlSeconds: value.config.ttlSeconds,
    proofTtlMs: value.config.proofTtlMs,
    publicKeys: new Map([[value.config.kid, publicKey]]),
  }
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_telemetry_writer`
  created = true
  runtime = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 2,
    ssl: false,
    connect_timeout: 3,
  })
  const count = async () =>
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE farm_id=${pending.farmId}::uuid AND agent_id=${pending.agentId}::uuid`
      )[0]?.n,
    )
  assert.equal(await count(), value.expectedCount)
  const service = new PostgresConnectorCredentialAcceptance(
    runtime,
    config,
    () => fixtureNow,
  )
  const result = await service.commitTelemetryWithProof(pending, body)
  assert.ok(result.ok && result.kind === 'telemetry-committed')
  assert.deepEqual(
    result.acceptedEventIds,
    operation.records.map((record) => record.eventId),
  )
  assert.equal(await count(), value.expectedCount)
  const again = new PostgresConnectorCredentialAcceptance(
    runtime,
    config,
    () => fixtureNow + 1000,
  )
  assert.deepEqual(await again.commitTelemetryWithProof(consumed, body), {
    ok: false,
    reason: 'denied',
  })
  const later = new PostgresConnectorCredentialAcceptance(
    runtime,
    config,
    () => fixtureNow + 2000,
  )
  assert.deepEqual(await later.commitTelemetryWithProof(pending, body), {
    ok: false,
    reason: 'denied',
  })
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: [
        'actual-postgresql-process-restart-lost-ack-fresh-proof-idempotent-batch-retry-old-proof-denied',
      ],
      databaseRestarted: true,
      processRestarted: true,
    }),
  )
} finally {
  if (runtime) await runtime.end({ timeout: 3 })
  if (created) await admin`DROP ROLE ${admin(role)}`
  await admin.end({ timeout: 3 })
}
