// Verify only; caller owns the isolated PostgreSQL restart and private synthetic fixture cleanup.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import {
  CredentialProofCompletion,
  CredentialProofPurpose,
} from '../packages/farm-protocol/src/credential-proof.ts'
import { PostgresConnectorCredentialAcceptance } from '../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
const port = Number(process.env.CREDENTIAL_ACCEPTANCE_SYNTHETIC_TEST_PORT)
const path = process.env.CREDENTIAL_ACCEPTANCE_RESTART_FIXTURE
if (
  process.argv.length !== 2 ||
  process.env.CREDENTIAL_ACCEPTANCE_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !path
)
  throw new Error('Disposable loopback fixture and restart evidence required')
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const bytes = await readFile(path)
const value: unknown = parseBoundedJson(
  new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  { maxBytes: 65536, maxDepth: 5, maxValues: 200, maxStringChars: 8192 },
)
if (
  !object(value) ||
  !object(value.config) ||
  Object.keys(value).sort().join(',') !==
    'config,databaseStarted,now,pendingProof,publicKeySpki,replayProof,seedPid' ||
  Object.keys(value.config).sort().join(',') !==
    'audience,issuer,kid,origin,proofTtlMs,purpose,ttlSeconds' ||
  typeof value.now !== 'number' ||
  !Number.isSafeInteger(value.now) ||
  value.now < 0 ||
  typeof value.seedPid !== 'number' ||
  !Number.isSafeInteger(value.seedPid) ||
  typeof value.databaseStarted !== 'string' ||
  typeof value.publicKeySpki !== 'string' ||
  typeof value.config.issuer !== 'string' ||
  typeof value.config.audience !== 'string' ||
  typeof value.config.origin !== 'string' ||
  typeof value.config.kid !== 'string' ||
  typeof value.config.ttlSeconds !== 'number' ||
  typeof value.config.proofTtlMs !== 'number'
)
  throw new Error('Invalid synthetic restart fixture')
const fixture = {
  pendingProof: CredentialProofCompletion.parse(value.pendingProof),
  replayProof: CredentialProofCompletion.parse(value.replayProof),
  now: value.now,
  publicKeySpki: value.publicKeySpki,
  seedPid: value.seedPid,
  databaseStarted: value.databaseStarted,
  config: {
    issuer: value.config.issuer,
    audience: value.config.audience,
    origin: value.config.origin,
    kid: value.config.kid,
    ttlSeconds: value.config.ttlSeconds,
    proofTtlMs: value.config.proofTtlMs,
    purpose: CredentialProofPurpose.parse(value.config.purpose),
  },
}
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 2,
  ssl: false,
  connect_timeout: 3,
})
const role = 'acceptance_restart_' + randomUUID().replaceAll('-', '')
let runtime: ReturnType<typeof postgres> | undefined
let created = false
try {
  const identity = (
    await admin`SELECT current_user AS username,current_database() AS database,pg_postmaster_start_time()::text AS started`
  )[0]
  assert.equal(identity?.username, 'fixture')
  assert.equal(identity?.database, 'fixture')
  assert.notEqual(identity.started, fixture.databaseStarted)
  assert.notEqual(process.pid, fixture.seedPid)
  const catalog = (await loadMigrationCatalog()).slice(0, 16)
  const history =
    await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), 16)
  const publicKey = await crypto.subtle.importKey(
    'spki',
    Buffer.from(fixture.publicKeySpki, 'base64url'),
    'Ed25519',
    true,
    ['verify'],
  )
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_acceptor`
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
  const service = new PostgresConnectorCredentialAcceptance(
    runtime,
    {
      ...fixture.config,
      publicKeys: new Map([[fixture.config.kid, publicKey]]),
    },
    () => fixture.now,
  )
  const pending = await service.accept(fixture.pendingProof)
  assert.ok(pending.ok && pending.kind === 'accepted')
  assert.equal(pending.connectionId, fixture.pendingProof.connectionId)
  assert.equal(pending.jti, fixture.pendingProof.challenge.jti)
  assert.equal((await service.accept(fixture.replayProof)).ok, false)
  const second = new PostgresConnectorCredentialAcceptance(
    runtime,
    {
      ...fixture.config,
      publicKeys: new Map([[fixture.config.kid, publicKey]]),
    },
    () => fixture.now + 1000,
  )
  assert.equal((await second.accept(fixture.pendingProof)).ok, false)
  assert.equal((await second.accept(fixture.replayProof)).ok, false)
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: [
        'actual-postgresql-and-process-restart-pending-proof-completes-once-consumed-proof-replay-denied',
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
