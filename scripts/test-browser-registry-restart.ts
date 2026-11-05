// Synthetic isolated fixture only; seed and verify run in separate processes.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { PostgresBrowserDeviceRegistry } from '../apps/farm/server/storage/postgres-browser-device-registry.ts'
import { signBrowserDeviceProof } from '../packages/farm-protocol/src/browser-device-proof.ts'

const port = Number(process.env.BROWSER_REGISTRY_SYNTHETIC_TEST_PORT)
const path = process.env.BROWSER_REGISTRY_RESTART_FIXTURE
if (
  process.env.BROWSER_REGISTRY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !path ||
  !['seed', 'verify'].includes(process.argv[2] ?? '') ||
  process.argv.length !== 3
)
  throw new Error('Disposable synthetic database and fixture path required')
const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 2,
  connect_timeout: 3,
})
const policy = { idleTimeoutMs: 1000000 },
  config = {
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:browser-device',
  }
const registry = new PostgresBrowserDeviceRegistry(sql, config, () => 1000)
try {
  const identity = (
    await sql`SELECT current_database() AS database, current_user AS username, pg_postmaster_start_time()::text AS started`
  )[0]
  assert.equal(identity?.database, 'fixture')
  assert.equal(identity?.username, 'fixture')
  const catalog = await loadMigrationCatalog()
  const history =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  assert.ok(
    catalog.some((entry) => entry.id === '0013_browser_device_registry'),
  )
  console.log(
    JSON.stringify({
      phase: process.argv[2],
      pid: process.pid,
      databaseStarted: identity.started,
    }),
  )
  if (process.argv[2] === 'seed') {
    const account = 'acct_' + randomUUID(),
      sessionRecordId = 'session_' + randomUUID(),
      farm = randomUUID()
    await sql`INSERT INTO farm.session_accounts(id) VALUES (${account})`
    await sql`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${sessionRecordId},${account},0,1000,1000,1000000)`
    await sql`INSERT INTO farm.farms(id) VALUES (${farm}::uuid)`
    await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farm}::uuid,${account},'owner')`
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )
    const issued = await registry.issueChallenge({
      sessionRecordId,
      policy,
      request: {
        farm_id: farm,
        public_key: { kty, crv, x, y },
        purpose: 'enroll',
      },
    })
    assert.ok(issued.ok)
    const request = {
      sessionRecordId,
      policy,
      request: {
        challenge_id: issued.challenge.challenge_id,
        signature: await signBrowserDeviceProof(
          issued.challenge,
          pair.privateKey,
        ),
      },
    }
    assert.ok((await registry.completeProof(request)).ok)
    const decision = {
      sessionRecordId,
      policy,
      request: {
        farm_id: farm,
        key_id: issued.challenge.key_id,
        expected_thumbprint: issued.challenge.thumbprint,
      },
    }
    assert.ok((await registry.revoke(decision)).ok)
    const replayPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const replayJwk = await crypto.subtle.exportKey('jwk', replayPair.publicKey)
    const replayIssued = await registry.issueChallenge({
      sessionRecordId,
      policy,
      request: {
        farm_id: farm,
        public_key: {
          kty: replayJwk.kty,
          crv: replayJwk.crv,
          x: replayJwk.x,
          y: replayJwk.y,
        },
        purpose: 'enroll',
      },
    })
    assert.ok(replayIssued.ok)
    const replayRequest = {
      sessionRecordId,
      policy,
      request: {
        challenge_id: replayIssued.challenge.challenge_id,
        signature: await signBrowserDeviceProof(
          replayIssued.challenge,
          replayPair.privateKey,
        ),
      },
    }
    assert.ok((await registry.completeProof(replayRequest)).ok)
    await writeFile(
      path,
      JSON.stringify({
        request,
        decision,
        replayRequest,
        replayKey: replayIssued.challenge.key_id,
        seedPid: process.pid,
        databaseStarted: identity.started,
      }),
      {
        flag: 'wx',
        mode: 0o600,
      },
    )
    console.log('seeded consumed challenge and revoked key')
  } else {
    const {
      request,
      decision,
      replayRequest,
      replayKey,
      seedPid,
      databaseStarted,
    } = JSON.parse(await readFile(path, 'utf8'))
    assert.notEqual(process.pid, seedPid)
    assert.notEqual(identity.started, databaseStarted)
    const rows =
      await sql`SELECT outcome, consumed_at::int AS consumed_at FROM farm.browser_device_challenges WHERE challenge_id=${replayRequest.request.challenge_id}::uuid`
    assert.deepEqual({ ...rows[0] }, { outcome: 'verified', consumed_at: 1000 })
    const states =
      await sql`SELECT key_id::text, status FROM farm.browser_device_keys WHERE key_id IN (${decision.request.key_id}::uuid, ${replayKey}::uuid)`
    assert.equal(
      states.find((row) => row.key_id === decision.request.key_id)?.status,
      'revoked',
    )
    assert.equal(
      states.find((row) => row.key_id === replayKey)?.status,
      'pending',
    )
    assert.deepEqual(await registry.completeProof(replayRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await registry.completeProof(request), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await registry.approve(decision), {
      ok: false,
      reason: 'denied',
    })
    console.log(
      'fresh process denied replay and revoked key after PostgreSQL restart',
    )
  }
} finally {
  await sql.end({ timeout: 3 })
}
