import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import {
  PostgresSignallingAuthorization,
  SIGNALLING_IDLE_TIMEOUT_MS,
} from '../../apps/farm/server/storage/postgres-signalling-authorization.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

export const signallingReaderFixtureConfig = {
  issuer: 'https://farm.example',
  origin: 'https://farm.example',
  audience: 'open3dfarmmanager:connector',
  idleTimeoutMs: SIGNALLING_IDLE_TIMEOUT_MS,
}
/** Explicit disposable fixture only. No hardware, production keys or token output. */
export async function testPostgresSignallingAuthorization(
  admin: Sql,
  runtime: Sql,
  applicationName: string,
  port: number,
  restartPath?: string,
): Promise<string[]> {
  const reader = () =>
    new PostgresSignallingAuthorization(runtime, signallingReaderFixtureConfig)
  const dbNow = async () =>
    Number(
      (
        await admin`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`
      )[0]?.now,
    )
  const proofConfig = {
    origin: signallingReaderFixtureConfig.origin,
    audience: 'open3dfarmmanager:pairing',
  }
  const checks: string[] = []
  async function actor(absoluteLifetime = 3600000, lastSeenAge = 1000) {
    const now = await dbNow(),
      id = randomUUID(),
      farmId = randomUUID()
    await admin`INSERT INTO farm.session_accounts(id) VALUES(${id})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${id},${id},0,${now - lastSeenAge - 1000},${now - lastSeenAge},${now + absoluteLifetime})`
    await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${id},'owner')`
    return {
      sessionRecordId: id,
      farmId,
      policy: { idleTimeoutMs: SIGNALLING_IDLE_TIMEOUT_MS },
    }
  }
  async function fixture(printerKeys: readonly string[] = ['fixture-printer']) {
    const subject = await actor()
    const identity = new ConnectorIdentity(
      generateKeyPairSync('ed25519').privateKey,
    )
    const pairing = new PostgresPairing(admin, proofConfig)
    const proof = new PostgresPairingProof(admin, proofConfig)
    const start = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.ok(start.ok)
    const challenge = await proof.issue({
      device_code: start.response.device_code,
    })
    assert.ok(challenge.ok)
    assert.equal(
      (
        await proof.complete({
          device_code: start.response.device_code,
          challenge: challenge.challenge,
          signature: identity.signPairingProof({
            challenge: challenge.challenge,
            expectedOrigin: proofConfig.origin,
            expectedAudience: proofConfig.audience,
            now: await dbNow(),
          }),
        })
      ).ok,
      true,
    )
    assert.equal(
      (
        await pairing.decide({
          ...subject,
          decision: 'approve',
          request: {
            user_code: start.response.user_code,
            farm_id: subject.farmId,
            expected_fingerprint: identity.fingerprint,
          },
        })
      ).ok,
      true,
    )
    const keys = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const claim = await pairing.claim(
      { device_code: start.response.device_code },
      {
        issuer: signallingReaderFixtureConfig.issuer,
        audience: signallingReaderFixtureConfig.audience,
        kid: 'signalling-fixture',
        privateKey: keys.privateKey,
        ttlSeconds: 600,
      },
    )
    assert.ok(claim.ok && claim.status === 'approved')
    const browser = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const exported = await crypto.subtle.exportKey('jwk', browser.publicKey)
    const key = await validateBrowserDevicePublicKey({
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
    })
    const keyId = randomUUID(),
      now = await dbNow()
    await admin`INSERT INTO farm.browser_device_keys(key_id,farm_id,account_id,public_key,thumbprint,created_at) VALUES(${keyId}::uuid,${subject.farmId}::uuid,${subject.sessionRecordId},${admin.json(key.publicKey)},${key.thumbprint},${now})`
    await admin`UPDATE farm.browser_device_keys SET proof_at=${now},proof_session_id=${subject.sessionRecordId},status='approved',approved_at=${now},approved_by=${subject.sessionRecordId} WHERE key_id=${keyId}::uuid`
    const scope = {
      sessionRecordId: subject.sessionRecordId,
      farmId: subject.farmId,
      agentId: challenge.challenge.agent_id,
      keyId,
    }
    const assignmentRefs = []
    for (const printerKey of printerKeys) {
      const result = await new PostgresPrinterOwnership(admin).register({
        ...scope,
        policy: subject.policy,
        printerKey,
      })
      assert.ok(result.ok && result.status === 'active')
      assignmentRefs.push({
        assignmentId: result.assignmentId,
        agentId: scope.agentId,
        printerKey,
      })
    }
    return { scope, identity, assignmentRefs }
  }
  const valid = await fixture()
  const before = (
    await admin`SELECT last_seen_at::text AS seen FROM farm.account_sessions WHERE id=${valid.scope.sessionRecordId}`
  )[0]?.seen
  const accepted = await reader().authorize(valid.scope)
  assert.ok(accepted.ok)
  assert.equal(accepted.authority.account_id, valid.scope.sessionRecordId)
  const expectedAssignments = await assignmentSetDigest(
    valid.scope,
    valid.assignmentRefs,
  )
  assert.equal(accepted.authority.assignment_count, expectedAssignments.count)
  assert.equal(accepted.authority.assignment_digest, expectedAssignments.digest)
  assert.equal(
    accepted.authority.connector_fingerprint,
    valid.identity.fingerprint,
  )
  assert.equal(
    (
      await admin`SELECT last_seen_at::text AS seen FROM farm.account_sessions WHERE id=${valid.scope.sessionRecordId}`
    )[0]?.seen,
    before,
  )
  assert.deepEqual(
    await reader().authorize({ ...valid.scope, farmId: randomUUID() }),
    { ok: false, reason: 'denied' },
  )
  assert.deepEqual(
    await reader().authorize({ ...valid.scope, keyId: randomUUID() }),
    { ok: false, reason: 'denied' },
  )
  assert.deepEqual(
    await reader().authorize({ ...valid.scope, agentId: randomUUID() }),
    { ok: false, reason: 'denied' },
  )
  checks.push(
    'current approved identity matches exact farm/session/key/credential without touching activity',
  )

  await assert.rejects(
    admin`UPDATE farm.session_accounts SET id=${randomUUID()} WHERE id=${valid.scope.sessionRecordId}`,
    /Invalid account session transition/i,
  )
  await assert.rejects(
    admin`UPDATE farm.account_sessions SET id=${randomUUID()} WHERE id=${valid.scope.sessionRecordId}`,
    /Invalid session transition/i,
  )
  await assert.rejects(
    admin`UPDATE farm.account_sessions SET account_id=${randomUUID()} WHERE id=${valid.scope.sessionRecordId}`,
    /Invalid session transition/i,
  )
  const functionState = (
    await admin`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid='farm.observe_signalling_session_expiry(text)'::regprocedure`
  )[0]
  assert.equal(functionState?.prosecdef, true)
  assert.equal(functionState?.owner, 'farm_signalling_expiry_owner')
  assert.deepEqual(
    functionState?.proconfig.map((value: string) => value.replaceAll(' ', '')),
    ['search_path=pg_catalog,farm,pg_temp'],
  )
  const flags = (
    await admin`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='farm_signalling_expiry_owner'`
  )[0]
  assert.ok(flags)
  assert.ok(Object.values(flags).every((value) => value === false))
  assert.equal(
    (
      await runtime`SELECT pg_has_role(current_user,'farm_signalling_expiry_owner','MEMBER') AS allowed`
    )[0]?.allowed,
    false,
  )
  await assert.rejects(
    runtime`SET ROLE farm_signalling_expiry_owner`,
    /permission denied/i,
  )
  await assert.rejects(
    runtime`ALTER FUNCTION farm.observe_signalling_session_expiry(text) SECURITY INVOKER`,
    /owner|permission denied/i,
  )
  await assert.rejects(
    runtime`CREATE TABLE farm.signalling_forbidden_probe(id int)`,
    /permission denied/i,
  )
  await admin.begin(async (tx) => {
    await tx`SET LOCAL ROLE farm_signalling_expiry_owner`
    assert.equal(
      (
        await tx`SELECT has_schema_privilege(current_user,'farm','CREATE') AS allowed`
      )[0]?.allowed,
      false,
    )
    assert.equal(
      (
        await tx`SELECT has_column_privilege(current_user,'farm.account_sessions','revoked_at','UPDATE') AS allowed`
      )[0]?.allowed,
      true,
    )
    assert.equal(
      (
        await tx`SELECT has_column_privilege(current_user,'farm.account_sessions','last_seen_at','UPDATE') AS allowed`
      )[0]?.allowed,
      false,
    )
    assert.equal(
      (
        await tx`SELECT has_table_privilege(current_user,'farm.connector_enrollments','SELECT') AS allowed`
      )[0]?.allowed,
      false,
    )
  })
  for (const operation of [
    (tx: import('postgres').TransactionSql) =>
      tx`UPDATE farm.account_sessions SET last_seen_at=last_seen_at WHERE id=${valid.scope.sessionRecordId}`,
    (tx: import('postgres').TransactionSql) =>
      tx`UPDATE farm.session_accounts SET disabled=true WHERE id=${valid.scope.sessionRecordId}`,
    (tx: import('postgres').TransactionSql) =>
      tx`CREATE TABLE farm.signalling_owner_forbidden_probe(id int)`,
    (tx: import('postgres').TransactionSql) =>
      tx`SELECT jti FROM farm.connector_credentials`,
    (tx: import('postgres').TransactionSql) =>
      tx`ALTER TABLE farm.account_sessions DISABLE TRIGGER ALL`,
  ])
    await assert.rejects(
      admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE farm_signalling_expiry_owner`
        await operation(tx)
      }),
      /permission denied|must be owner/i,
    )
  const attack = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: applicationName,
    password: '',
    max: 1,
    connect_timeout: 3,
  })
  try {
    // A fresh backend must compile the definer function only AFTER these hostile temporary types exist.
    await attack`CREATE TEMP TABLE signalling_type_probe(actor pg_catalog.text NOT NULL)`
    await attack`CREATE FUNCTION pg_temp.signalling_type_probe(value pg_catalog.text) RETURNS pg_catalog.bool LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN IF current_user <> session_user THEN RAISE EXCEPTION 'Definer execution reached caller temporary domain'; END IF; INSERT INTO pg_temp.signalling_type_probe(actor) VALUES(current_user); RETURN true; END $$`
    await attack`CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.signalling_type_probe(VALUE))`
    await attack`SELECT 'reader-domain-probe'::pg_temp.text`
    assert.deepEqual(
      (await attack`SELECT actor FROM pg_temp.signalling_type_probe`).map(
        (row) => row.actor,
      ),
      [applicationName],
    )
    await attack`TRUNCATE pg_temp.signalling_type_probe`
    assert.ok(
      (
        await attack`SELECT farm.observe_signalling_session_expiry(${valid.scope.sessionRecordId})::float8 AS at`
      )[0]?.at,
    )
    assert.equal(
      Number(
        (
          await attack`SELECT count(*)::int AS n FROM pg_temp.signalling_type_probe`
        )[0]?.n,
      ),
      0,
    )
  } finally {
    await attack.end({ timeout: 3 })
  }
  checks.push(
    'fresh restricted backend temporary text domain cannot execute inside the constrained definer owner',
  )

  // All lock-only grants must reject identity writes through the real lifecycle triggers.
  await assert.rejects(
    runtime`UPDATE farm.memberships SET farm_id=${randomUUID()}::uuid WHERE farm_id=${valid.scope.farmId}::uuid AND account_id=${valid.scope.sessionRecordId}`,
    /identity|terminal/i,
  )
  await assert.rejects(
    runtime`UPDATE farm.browser_device_keys SET key_id=${randomUUID()}::uuid WHERE key_id=${valid.scope.keyId}::uuid`,
    /identity|immutable/i,
  )
  await assert.rejects(
    runtime`UPDATE farm.connector_enrollments SET agent_id=${randomUUID()}::uuid WHERE agent_id=${valid.scope.agentId}::uuid`,
    /identity|immutable/i,
  )
  await assert.rejects(
    runtime`UPDATE farm.connector_credentials SET jti=jti WHERE agent_id=${valid.scope.agentId}::uuid`,
    /immutable/i,
  )
  for (const sql of [
    () =>
      runtime`UPDATE farm.account_sessions SET last_seen_at=last_seen_at WHERE id=${valid.scope.sessionRecordId}`,
    () =>
      runtime`UPDATE farm.account_sessions SET revoked_at=0 WHERE id=${valid.scope.sessionRecordId}`,
    () =>
      runtime`UPDATE farm.session_accounts SET disabled=true WHERE id=${valid.scope.sessionRecordId}`,
    () =>
      runtime`UPDATE farm.memberships SET role='admin' WHERE farm_id=${valid.scope.farmId}::uuid`,
    () =>
      runtime`UPDATE farm.browser_device_keys SET status='revoked' WHERE key_id=${valid.scope.keyId}::uuid`,
    () =>
      runtime`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${valid.scope.agentId}::uuid`,
    () =>
      runtime`UPDATE farm.connector_credential_proofs SET status='consumed' WHERE jti=${accepted.authority.credential_jti}::uuid`,
    () =>
      runtime`INSERT INTO farm.telemetry_events(farm_id,agent_id,event_id,payload) VALUES(${valid.scope.farmId}::uuid,${valid.scope.agentId}::uuid,${randomUUID()}::uuid,'{}'::jsonb)`,
  ])
    await assert.rejects(sql(), /permission denied/i)
  assert.equal(
    (
      await admin`SELECT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='farm.observe_signalling_session_expiry(text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`
    )[0]?.allowed,
    false,
  )
  checks.push(
    'identity-only lock grants enforce all lifecycle triggers and deny authority/telemetry mutations',
  )

  assert.deepEqual(
    await new PostgresSignallingAuthorization(runtime, {
      ...signallingReaderFixtureConfig,
      issuer: 'other-issuer',
    }).authorize(valid.scope),
    { ok: false, reason: 'denied' },
  )
  assert.deepEqual(
    await new PostgresSignallingAuthorization(runtime, {
      ...signallingReaderFixtureConfig,
      audience: 'other-audience',
    }).authorize(valid.scope),
    { ok: false, reason: 'denied' },
  )
  assert.deepEqual(
    await reader().authorize({ ...valid.scope, sessionRecordId: randomUUID() }),
    { ok: false, reason: 'denied' },
  )
  assert.equal(
    (
      await runtime`SELECT farm.observe_signalling_session_expiry(${randomUUID()}) AS observed_at`
    )[0]?.observed_at,
    null,
  )
  const missing = await actor()
  assert.deepEqual(
    await reader().authorize({
      ...valid.scope,
      sessionRecordId: missing.sessionRecordId,
    }),
    { ok: false, reason: 'denied' },
  )
  assert.equal(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${missing.sessionRecordId}`
    )[0]?.revoked_at,
    null,
  )
  await runtime`SELECT farm.observe_signalling_session_expiry(${valid.scope.sessionRecordId})`
  assert.equal(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${valid.scope.sessionRecordId}`
    )[0]?.revoked_at,
    null,
  )
  await assert.rejects(
    runtime`SELECT farm.observe_signalling_session_expiry(${valid.scope.sessionRecordId},0::bigint)`,
    /does not exist/i,
  )
  checks.push(
    'expiry function cannot revoke a live session or accept caller-selected time/policy',
  )

  const expired = await actor(-1)
  const expiredScope = {
    ...valid.scope,
    sessionRecordId: expired.sessionRecordId,
  }
  assert.deepEqual(await reader().authorize(expiredScope), {
    ok: false,
    reason: 'denied',
  })
  const tombstone = (
    await admin`SELECT revoked_at::text AS at,last_seen_at::text AS seen FROM farm.account_sessions WHERE id=${expired.sessionRecordId}`
  )[0]
  assert.ok(tombstone?.at)
  const savedClock = Date.now
  try {
    Date.now = () => 1
    assert.deepEqual(await reader().authorize(expiredScope), {
      ok: false,
      reason: 'denied',
    })
  } finally {
    Date.now = savedClock
  }
  assert.equal(
    (
      await admin`SELECT revoked_at::text AS at FROM farm.account_sessions WHERE id=${expired.sessionRecordId}`
    )[0]?.at,
    tombstone.at,
  )
  const idle = await actor(3600000, SIGNALLING_IDLE_TIMEOUT_MS + 1000)
  assert.deepEqual(
    await reader().authorize({
      ...valid.scope,
      sessionRecordId: idle.sessionRecordId,
    }),
    { ok: false, reason: 'denied' },
  )
  assert.ok(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${idle.sessionRecordId}`
    )[0]?.revoked_at,
  )
  checks.push(
    'denied absolute/idle expiry commits terminal tombstones and ignores regressed application clock',
  )

  // Serialize the reader behind a real row lock, with bounded actual DB expiry while waiting.
  const unavailable = await actor(-1)
  let releaseUnavailable: (() => void) | undefined,
    unavailableLocked: (() => void) | undefined
  const unavailableReady = new Promise<void>((resolve) => {
    unavailableLocked = resolve
  })
  const unavailableGate = new Promise<void>((resolve) => {
    releaseUnavailable = resolve
  })
  const unavailableHolding = admin.begin(async (tx) => {
    await tx`SELECT id FROM farm.session_accounts WHERE id=${unavailable.sessionRecordId} FOR UPDATE`
    unavailableLocked?.()
    await unavailableGate
  })
  await unavailableReady
  try {
    assert.deepEqual(
      await reader().authorize({
        ...valid.scope,
        sessionRecordId: unavailable.sessionRecordId,
      }),
      { ok: false, reason: 'storage-unavailable' },
    )
    assert.equal(
      (
        await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${unavailable.sessionRecordId}`
      )[0]?.revoked_at,
      null,
    )
  } finally {
    releaseUnavailable?.()
    await unavailableHolding
  }
  assert.deepEqual(
    await reader().authorize({
      ...valid.scope,
      sessionRecordId: unavailable.sessionRecordId,
    }),
    { ok: false, reason: 'denied' },
  )
  assert.ok(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${unavailable.sessionRecordId}`
    )[0]?.revoked_at,
  )
  checks.push(
    'lock-timeout storage failure never claims expiry persistence; a later successful denial records expiry',
  )

  const waiting = await actor(600)
  const waitingExpiry = Number(
    (
      await admin`SELECT absolute_expires_at::float8 AS at FROM farm.account_sessions WHERE id=${waiting.sessionRecordId}`
    )[0]?.at,
  )
  let release: (() => void) | undefined
  let locked: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    locked = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const holding = admin.begin(async (tx) => {
    await tx`SELECT id FROM farm.session_accounts WHERE id=${waiting.sessionRecordId} FOR UPDATE`
    locked?.()
    await gate
  })
  await ready
  const pending = reader().authorize({
    ...valid.scope,
    sessionRecordId: waiting.sessionRecordId,
  })
  try {
    const until = Date.now() + 700
    let sawWait = false
    while (Date.now() < until) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${applicationName} AND wait_event_type='Lock' AND query LIKE '%observe_signalling_session_expiry%'`
      if (Number(rows[0]?.n) > 0) {
        sawWait = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(sawWait, true)
    const liveAtWait = await dbNow()
    assert.ok(
      liveAtWait < waitingExpiry,
      'Session must still be live when actual account contention is observed',
    )
    await new Promise((resolve) =>
      setTimeout(resolve, waitingExpiry - liveAtWait + 25),
    )
  } finally {
    release?.()
    await Promise.allSettled([holding, pending])
  }
  await holding
  assert.deepEqual(await pending, { ok: false, reason: 'denied' })
  assert.ok(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${waiting.sessionRecordId}`
    )[0]?.revoked_at,
  )
  checks.push(
    'actual account-lock wait crosses expiry and denial durably commits after lock acquisition',
  )

  // Final expiry check must also run after a later membership lock wait.
  const lateSession = randomUUID(),
    lateNow = await dbNow()
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${lateSession},${valid.scope.sessionRecordId},0,${lateNow - 2000},${lateNow - 1000},${lateNow + 600})`
  let releaseMember: (() => void) | undefined,
    memberLocked: (() => void) | undefined
  const memberReady = new Promise<void>((resolve) => {
    memberLocked = resolve
  })
  const memberGate = new Promise<void>((resolve) => {
    releaseMember = resolve
  })
  const memberHolding = admin.begin(async (tx) => {
    await tx`SELECT farm_id FROM farm.memberships WHERE farm_id=${valid.scope.farmId}::uuid AND account_id=${valid.scope.sessionRecordId} FOR UPDATE`
    memberLocked?.()
    await memberGate
  })
  await memberReady
  const lateRead = reader().authorize({
    ...valid.scope,
    sessionRecordId: lateSession,
  })
  try {
    const until = Date.now() + 700
    let waitingForMember = false
    while (Date.now() < until) {
      if (
        Number(
          (
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${applicationName} AND wait_event_type='Lock' AND query LIKE '%farm.memberships%'`
          )[0]?.n,
        ) > 0
      ) {
        waitingForMember = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(waitingForMember, true)
    const liveAtWait = await dbNow()
    assert.ok(
      liveAtWait < lateNow + 600,
      'Session must still be live at the later membership wait',
    )
    await new Promise((resolve) =>
      setTimeout(resolve, lateNow + 600 - liveAtWait + 25),
    )
  } finally {
    releaseMember?.()
    await Promise.allSettled([memberHolding, lateRead])
  }
  await memberHolding
  assert.deepEqual(await lateRead, { ok: false, reason: 'denied' })
  assert.ok(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${lateSession}`
    )[0]?.revoked_at,
  )
  checks.push(
    'final post-membership-lock expiry commits its tombstone on authorization denial',
  )

  const linear = await fixture()
  let releaseCredential: (() => void) | undefined,
    credentialLocked: (() => void) | undefined
  const credentialReady = new Promise<void>((resolve) => {
    credentialLocked = resolve
  })
  const credentialGate = new Promise<void>((resolve) => {
    releaseCredential = resolve
  })
  const credentialHolding = admin.begin(async (tx) => {
    await tx`SELECT jti FROM farm.connector_credentials WHERE agent_id=${linear.scope.agentId}::uuid FOR UPDATE`
    credentialLocked?.()
    await credentialGate
  })
  await credentialReady
  const firstRead = reader().authorize(linear.scope)
  let revokePromise: Promise<unknown> | undefined
  const revokeApplication = applicationName.slice(0, 48) + '_revoke'
  try {
    let readerWaiting = false
    const until = Date.now() + 300
    while (Date.now() < until) {
      if (
        Number(
          (
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${applicationName} AND wait_event_type='Lock' AND query LIKE '%farm.connector_credentials%'`
          )[0]?.n,
        ) > 0
      ) {
        readerWaiting = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(readerWaiting, true)
    revokePromise = admin.begin(async (tx) => {
      await tx`SELECT set_config('application_name',${revokeApplication},true)`
      await tx`SELECT id FROM farm.session_accounts WHERE id=${linear.scope.sessionRecordId} FOR UPDATE`
      await tx`UPDATE farm.account_sessions SET revoked_at=${await dbNow()} WHERE id=${linear.scope.sessionRecordId}`
    })
    let revokerWaiting = false
    const revokeUntil = Date.now() + 300
    while (Date.now() < revokeUntil) {
      if (
        Number(
          (
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${revokeApplication} AND wait_event_type='Lock'`
          )[0]?.n,
        ) > 0
      ) {
        revokerWaiting = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(revokerWaiting, true)
  } finally {
    releaseCredential?.()
    await Promise.allSettled([
      credentialHolding,
      firstRead,
      revokePromise ?? Promise.resolve(),
    ])
  }
  await credentialHolding
  try {
    assert.equal((await firstRead).ok, true)
  } finally {
    await revokePromise
  }
  assert.deepEqual(await reader().authorize(linear.scope), {
    ok: false,
    reason: 'denied',
  })
  checks.push(
    'reader-before-session-revoke has proven row contention and next context observes terminal revoke',
  )

  // Migration 0019 exposes only immutable identity/scope plus active tombstones.
  for (const column of [
    'id',
    'farm_id',
    'agent_id',
    'printer_key',
    'revoked_at',
  ]) {
    const granted =
      await runtime`SELECT has_column_privilege(current_user,'farm.printer_assignments',${column},'SELECT') AS allowed`
    assert.equal(granted[0]?.allowed, true)
  }
  for (const column of ['created_at', 'created_by', 'revoked_by']) {
    const denied =
      await runtime`SELECT has_column_privilege(current_user,'farm.printer_assignments',${column},'SELECT') AS allowed`
    assert.equal(denied[0]?.allowed, false)
  }
  await runtime`SELECT id,farm_id,agent_id,printer_key,revoked_at FROM farm.printer_assignments LIMIT 1`
  await assert.rejects(
    runtime`SELECT created_by FROM farm.printer_assignments LIMIT 0`,
    /permission denied/i,
  )
  await assert.rejects(
    runtime`UPDATE farm.printer_assignments SET revoked_at=revoked_at WHERE false`,
    /permission denied/i,
  )
  await assert.rejects(
    runtime`DELETE FROM farm.printer_assignments WHERE false`,
    /permission denied/i,
  )
  await assert.rejects(
    runtime`TRUNCATE farm.printer_assignments`,
    /permission denied/i,
  )
  await assert.rejects(
    runtime`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) SELECT id,farm_id,agent_id,printer_key,created_at,created_by FROM farm.printer_assignments WHERE false`,
    /permission denied/i,
  )
  checks.push(
    'assignment scope has five SELECT columns only, no hidden audit columns or mutation capability',
  )

  const emptyAssignments = await fixture([])
  assert.deepEqual(await reader().authorize(emptyAssignments.scope), {
    ok: false,
    reason: 'denied',
  })
  const tooManyAssignments = await fixture(
    Array.from({ length: 17 }, (_, i) => `printer-${i}`),
  )
  assert.deepEqual(await reader().authorize(tooManyAssignments.scope), {
    ok: false,
    reason: 'denied',
  })
  const edgeKeys = [
    'e\u0301',
    'é',
    ' 打印机\n ',
    '😀'.repeat(64),
    ...Array.from({ length: 12 }, (_, i) => `edge-${i}`),
  ]
  const edgeAssignments = await fixture(edgeKeys)
  const edgeRead = await reader().authorize(edgeAssignments.scope)
  assert.ok(edgeRead.ok)
  const edgeDigest = await assignmentSetDigest(
    edgeAssignments.scope,
    edgeAssignments.assignmentRefs,
  )
  assert.equal(edgeRead.authority.assignment_count, 16)
  assert.equal(edgeRead.authority.assignment_digest, edgeDigest.digest)
  checks.push(
    'complete assignment count denies empty and 17th rows; 16 exact Unicode identities match shared digest',
  )

  async function waitForLock(name: string, fragment: string) {
    const until = Date.now() + 400
    while (Date.now() < until) {
      const found =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${name} AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (Number(found[0]?.n) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail('Expected real database lock contention')
  }
  for (const order of ['reader-first', 'writer-first'] as const) {
    for (const operation of ['insert-empty', 'revoke'] as const) {
      const subject = await fixture(
        operation === 'insert-empty' ? [] : ['race-printer'],
      )
      const writerActor = await actor()
      await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${subject.scope.farmId}::uuid,${writerActor.sessionRecordId},'owner')`
      const writerName =
        'assignment_scope_writer_' + randomUUID().replaceAll('-', '')
      const writerSql = postgres({
        host: '127.0.0.1',
        port,
        database: 'fixture',
        username: 'fixture',
        password: '',
        ssl: false,
        max: 1,
        connect_timeout: 3,
        connection: { application_name: writerName },
      })
      const writer = new PostgresPrinterOwnership(writerSql)
      const request = {
        sessionRecordId: writerActor.sessionRecordId,
        policy: writerActor.policy,
        farmId: subject.scope.farmId,
        agentId: subject.scope.agentId,
        printerKey: 'race-printer',
      }
      let release: () => void = () => {}
      let ready: () => void = () => {},
        rejectReady: (error: unknown) => void = () => {}
      const gated = new Promise<void>((resolve, reject) => {
        ready = resolve
        rejectReady = reject
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const holding = admin
        .begin(async (tx) => {
          if (order === 'reader-first')
            await tx`SELECT jti FROM farm.connector_credentials WHERE agent_id=${subject.scope.agentId}::uuid FOR UPDATE`
          else
            await tx`LOCK TABLE farm.printer_assignments IN ACCESS EXCLUSIVE MODE`
          ready()
          await gate
        })
        .catch((error) => {
          rejectReady(error)
          throw error
        })
      void holding.catch(() => {})
      let reading:
        | ReturnType<PostgresSignallingAuthorization['authorize']>
        | undefined
      let writing: ReturnType<PostgresPrinterOwnership['register']> | undefined
      try {
        await gated
        const change = () =>
          operation === 'insert-empty'
            ? writer.register(request)
            : writer.revoke({
                ...request,
                expectedAssignmentId: subject.assignmentRefs[0]!.assignmentId,
              })
        if (order === 'reader-first') {
          reading = reader().authorize(subject.scope)
          await waitForLock(applicationName, 'farm.connector_credentials')
          writing = change()
          await waitForLock(writerName, 'farm.connector_enrollments')
        } else {
          writing = change()
          await waitForLock(writerName, 'farm.printer_assignments')
          reading = reader().authorize(subject.scope)
          await waitForLock(applicationName, 'farm.connector_enrollments')
        }
      } finally {
        release()
        await Promise.allSettled([
          holding,
          reading ?? Promise.resolve(),
          writing ?? Promise.resolve(),
        ])
        await writerSql.end({ timeout: 2 })
      }
      await holding
      if (reading === undefined || writing === undefined)
        throw new Error('Both contention operations must have started')
      const initial = await reading,
        changed = await writing
      assert.ok(changed.ok)
      if (order === 'reader-first') {
        assert.equal(initial.ok, operation === 'revoke')
        if (initial.ok) assert.equal(initial.authority.assignment_count, 1)
      } else assert.equal(initial.ok, operation === 'insert-empty')
      const next = await reader().authorize(subject.scope)
      assert.equal(next.ok, operation === 'insert-empty')
      if (operation === 'revoke') {
        // Same key with a fresh immutable assignment ID must change the pin.
        assert.ok(initial.ok || order === 'writer-first')
        const replacement = await new PostgresPrinterOwnership(admin).register({
          ...request,
          sessionRecordId: subject.scope.sessionRecordId,
        })
        assert.ok(replacement.ok)
        assert.notEqual(
          replacement.assignmentId,
          subject.assignmentRefs[0]!.assignmentId,
        )
        const fresh = await reader().authorize(subject.scope)
        assert.ok(fresh.ok)
        const prior = await assignmentSetDigest(
          subject.scope,
          subject.assignmentRefs,
        )
        assert.notEqual(fresh.authority.assignment_digest, prior.digest)
      }
      checks.push(
        `maintained ${order} ${operation} has proven enrollment contention and exact post-commit assignment pins`,
      )
    }
  }

  // Deliberately demonstrate the stated trust boundary, not an extra guarantee:
  // trusted direct writer SQL can bypass the maintained enrollment UPDATE order.
  const bypass = await fixture([])
  let releaseBypass: () => void = () => {},
    readyBypass: () => void = () => {},
    rejectBypass: (error: unknown) => void = () => {}
  const bypassGate = new Promise<void>((resolve) => {
    releaseBypass = resolve
  })
  const bypassReady = new Promise<void>((resolve, reject) => {
    readyBypass = resolve
    rejectBypass = reject
  })
  const bypassHolding = admin
    .begin(async (tx) => {
      await tx`SELECT agent_id FROM farm.connector_enrollments WHERE agent_id=${bypass.scope.agentId}::uuid FOR SHARE`
      readyBypass()
      await bypassGate
    })
    .catch((error) => {
      rejectBypass(error)
      throw error
    })
  void bypassHolding.catch(() => {})
  let bypassWrite: Promise<unknown> | undefined
  let bypassTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await bypassReady
    bypassWrite = admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE farm_printer_ownership`
      await tx`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES(${randomUUID()}::uuid,${bypass.scope.farmId}::uuid,${bypass.scope.agentId}::uuid,'direct-trusted-writer',${await dbNow()},${bypass.scope.sessionRecordId})`
    })
    await Promise.race([
      bypassWrite,
      new Promise<never>((_, reject) => {
        bypassTimer = setTimeout(
          () => reject(Error('Direct writer unexpectedly serialized')),
          400,
        )
      }),
    ])
  } finally {
    clearTimeout(bypassTimer)
    releaseBypass()
    await Promise.allSettled([bypassHolding, bypassWrite ?? Promise.resolve()])
  }
  await bypassHolding
  await bypassWrite
  checks.push(
    'explicit trusted direct-SQL writer bypass is demonstrated; only maintained writer lock protocol is claimed',
  )

  await admin`UPDATE farm.memberships SET revoked_at=${await dbNow()} WHERE farm_id=${valid.scope.farmId}::uuid AND account_id=${valid.scope.sessionRecordId}`
  assert.deepEqual(await reader().authorize(valid.scope), {
    ok: false,
    reason: 'denied',
  })
  const browserRevoked = await fixture()
  await admin`UPDATE farm.browser_device_keys SET status='revoked',revoked_at=${await dbNow()},revoked_by=${browserRevoked.scope.sessionRecordId} WHERE key_id=${browserRevoked.scope.keyId}::uuid`
  assert.deepEqual(await reader().authorize(browserRevoked.scope), {
    ok: false,
    reason: 'denied',
  })
  const enrollmentRevoked = await fixture()
  await admin`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${enrollmentRevoked.scope.agentId}::uuid`
  assert.deepEqual(await reader().authorize(enrollmentRevoked.scope), {
    ok: false,
    reason: 'denied',
  })
  checks.push(
    'current membership/browser-key/enrollment revocation denies fresh contexts',
  )

  if (restartPath)
    await writeFile(
      restartPath,
      JSON.stringify({ v: 1, scope: expiredScope, revokedAt: tombstone.at }),
      { mode: 0o600, flag: 'wx' },
    )
  return checks
}
