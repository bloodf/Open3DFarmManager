import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'

/** Caller owns disposable loopback DB and migrations 0001–0007; rows remain for caller teardown. */
export async function testPostgresPairing(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const role = 'pairing_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pairing_runtime`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 6,
    connect_timeout: 3,
    connection: { application_name: role },
  })
  let now =
    Number(
      (
        await admin`SELECT coalesce(max(expires_at), 0)::float8 AS n FROM farm.pairing_requests`
      )[0]?.n,
    ) + 100_000
  const pairing = new PostgresPairing(sql, () => now)
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const checks: string[] = []
  async function start() {
    const result = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('Pairing start failed')
    return result.response
  }
  async function member(role = 'owner') {
    const id = randomUUID()
    const farmId = randomUUID()
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${id}, ${id}, 0, ${now}, ${now}, ${now + 2000000})`
    await admin`INSERT INTO farm.farms (id) VALUES (${farmId}::uuid)`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farmId}::uuid, ${id}, ${role})`
    return { sessionRecordId: id, farmId, policy: { idleTimeoutMs: 2000000 } }
  }
  function decision(
    code: Awaited<ReturnType<typeof start>>,
    owner: Awaited<ReturnType<typeof member>>,
    action: 'approve' | 'deny' = 'approve',
  ) {
    return pairing.decide({
      ...owner,
      decision: action,
      request: {
        user_code: code.user_code,
        farm_id: owner.farmId,
        expected_fingerprint: code.fingerprint,
      },
    })
  }
  async function waitForLock(fragment: string) {
    const deadline = performance.now() + 750
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${role} AND wait_event_type = 'Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (rows[0]?.n > 0) return
      assert.ok(performance.now() < deadline, 'Expected lock wait ' + fragment)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    const code = await start()
    assert.equal(code.expires_at - code.issued_at, 900000)
    const stored = (
      await admin`SELECT device_code_hash, user_code_hash, farm_id FROM farm.pairing_requests WHERE device_code_hash = encode(sha256(convert_to(${code.device_code}, 'UTF8')), 'hex')`
    )[0]
    assert.ok(stored)
    assert.notEqual(stored.device_code_hash, code.device_code)
    assert.notEqual(stored.user_code_hash, code.user_code)
    assert.equal(stored.farm_id, null)
    assert.deepEqual(await pairing.claim({ device_code: code.device_code }), {
      ok: true,
      status: 'pending',
      retry_after_s: 5,
    })
    assert.deepEqual(await pairing.claim({ device_code: code.device_code }), {
      ok: true,
      status: 'slow_down',
      retry_after_s: 5,
    })
    for (const role of ['operator', 'viewer'])
      assert.deepEqual(await decision(code, await member(role)), {
        ok: false,
        reason: 'denied',
      })
    const owner = await member()
    assert.deepEqual(
      await pairing.decide({
        ...owner,
        decision: 'approve',
        request: {
          user_code: code.user_code,
          farm_id: randomUUID(),
          expected_fingerprint: code.fingerprint,
        },
      }),
      { ok: false, reason: 'denied' },
    )
    assert.deepEqual(
      await pairing.decide({
        ...owner,
        decision: 'approve',
        request: {
          user_code: code.user_code,
          farm_id: owner.farmId,
          expected_fingerprint: 'SHA256:' + 'A'.repeat(43),
        },
      }),
      { ok: false, reason: 'denied' },
    )
    const results = await Promise.all([
      decision(code, owner),
      decision(code, await member('admin')),
    ])
    assert.equal(results.filter((x) => x.ok).length, 1)
    assert.deepEqual(await decision(code, owner), {
      ok: false,
      reason: 'denied',
    })
    now += 5000
    const claimed = await Promise.all([
      pairing.claim({ device_code: code.device_code }),
      pairing.claim({ device_code: code.device_code }),
    ])
    assert.equal(
      claimed.filter((x) => x.ok && x.status === 'claimed').length,
      1,
    )
    assert.equal(
      claimed.filter((x) => !x.ok && x.reason === 'denied').length,
      1,
    )
    const grant = claimed.find((x) => x.ok && x.status === 'claimed')
    assert.ok(grant?.ok && grant.status === 'claimed')
    if (grant?.ok && grant.status === 'claimed') {
      assert.equal(grant.fingerprint, identity.fingerprint)
      assert.equal(grant.publicKeySpki, identity.publicKeySpki)
      assert.equal(
        (
          await admin`SELECT status FROM farm.connector_enrollments WHERE agent_id = ${grant.agentId}::uuid`
        )[0]?.status,
        'approved',
      )
    }
    checks.push(
      'hashed-pre-farm-codes-owner-admin-only-fingerprint-binding-single-approval-single-claim',
    )

    const denied = await start()
    assert.deepEqual(await decision(denied, await member(), 'deny'), {
      ok: true,
      status: 'denied',
    })
    assert.deepEqual(await decision(denied, await member()), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await pairing.claim({ device_code: denied.device_code }), {
      ok: true,
      status: 'denied',
    })
    const expired = await start()
    const expiryOwner = await member()
    now = expired.expires_at
    assert.deepEqual(await decision(expired, expiryOwner), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      await pairing.claim({ device_code: expired.device_code }),
      { ok: true, status: 'expired' },
    )
    const approvedExpiry = await start()
    assert.equal((await decision(approvedExpiry, await member())).ok, true)
    now = approvedExpiry.expires_at
    assert.deepEqual(
      await pairing.claim({ device_code: approvedExpiry.device_code }),
      { ok: true, status: 'expired' },
    )
    checks.push('denial-replay-exact-deadline-and-approved-delivery-expiry')

    // Revocation commits while decision waits: stale membership must never authorize.
    const raceCode = await start()
    const raceOwner = await member()
    const blocker = await admin.reserve()
    await blocker`BEGIN`
    await blocker`UPDATE farm.memberships SET revoked_at = ${now} WHERE farm_id = ${raceOwner.farmId}::uuid`
    const race = decision(raceCode, raceOwner)
    try {
      await waitForLock('SELECT role, revoked_at')
    } finally {
      await blocker`COMMIT`
      blocker.release()
    }
    assert.deepEqual(await race, { ok: false, reason: 'denied' })
    // Expiry advances while waiting for the request lock, so clock must be sampled afterward.
    const delayed = await start()
    const delayedOwner = await member()
    const held = await admin.reserve()
    await held`BEGIN`
    await held`SELECT agent_id FROM farm.pairing_requests WHERE user_code_hash = encode(sha256(convert_to(${delayed.user_code}, 'UTF8')), 'hex') FOR UPDATE`
    const late = decision(delayed, delayedOwner)
    try {
      await waitForLock('FROM farm.pairing_requests')
      now = delayed.expires_at
    } finally {
      await held`COMMIT`
      held.release()
    }
    assert.deepEqual(await late, { ok: false, reason: 'denied' })
    checks.push('membership-revocation-and-expiry-during-row-lock-wait')

    const revoked = await start()
    const revokedOwner = await member()
    assert.equal((await decision(revoked, revokedOwner)).ok, true)
    await admin`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE farm_id = ${revokedOwner.farmId}::uuid`
    assert.deepEqual(
      await pairing.claim({ device_code: revoked.device_code }),
      { ok: false, reason: 'denied' },
    )
    const deliveryExpiry = await start()
    assert.equal((await decision(deliveryExpiry, await member())).ok, true)
    const deliveryGate = await admin.reserve()
    await deliveryGate`BEGIN`
    await deliveryGate`SELECT agent_id FROM farm.connector_enrollments WHERE agent_id = (SELECT agent_id FROM farm.pairing_requests WHERE user_code_hash = encode(sha256(convert_to(${deliveryExpiry.user_code}, 'UTF8')), 'hex')) FOR UPDATE`
    const lateClaim = pairing.claim({ device_code: deliveryExpiry.device_code })
    try {
      await waitForLock('SELECT status, farm_id')
      now = deliveryExpiry.expires_at
    } finally {
      await deliveryGate`COMMIT`
      deliveryGate.release()
    }
    assert.deepEqual(await lateClaim, { ok: true, status: 'expired' })
    checks.push(
      'revoked-enrollment-and-expiry-during-enrollment-lock-prevent-claim',
    )

    // Commit failure must roll back approval, enrollment and session touch together.
    const rollback = await start()
    const rollbackOwner = await member()
    await admin
      .unsafe(
        `CREATE FUNCTION farm.fail_pairing_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_pairing_fixture AFTER UPDATE ON farm.pairing_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_pairing_fixture();`,
      )
      .simple()
    try {
      assert.deepEqual(await decision(rollback, rollbackOwner), {
        ok: false,
        reason: 'storage-unavailable',
      })
      assert.equal(
        (
          await admin`SELECT count(*)::int AS n FROM farm.connector_enrollments WHERE farm_id = ${rollbackOwner.farmId}::uuid`
        )[0]?.n,
        0,
      )
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_pairing_fixture ON farm.pairing_requests; DROP FUNCTION farm.fail_pairing_fixture();',
        )
        .simple()
    }
    assert.equal((await decision(rollback, rollbackOwner)).ok, true)
    checks.push('deferred-commit-failure-rolls-back-approval-and-enrollment')

    for (const query of [
      'DELETE FROM farm.pairing_requests',
      'TRUNCATE farm.pairing_requests',
      "UPDATE farm.pairing_requests SET fingerprint = 'SHA256:' || repeat('A',43)",
      "UPDATE farm.pairing_requests SET status = 'pending' WHERE status = 'consumed'",
      "UPDATE farm.memberships SET role = 'owner'",
      'UPDATE farm.session_accounts SET disabled = false',
      'CREATE TABLE farm.forbidden_pairing (id int)',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.pairing_requests SET user_code_hash = repeat('b',64) WHERE agent_id = (SELECT agent_id FROM farm.pairing_requests LIMIT 1)`,
    )
    checks.push('restricted-capability-and-database-terminal-identity-guards')
    const active = (
      await admin`SELECT count(*)::int AS n FROM farm.pairing_requests WHERE status IN ('pending','approved') AND expires_at > ${now}`
    )[0]?.n
    assert.equal(typeof active, 'number')
    await admin`INSERT INTO farm.pairing_requests (agent_id, device_code_hash, user_code_hash, public_key_spki, fingerprint, platform, version, issued_at, expires_at, next_poll_at)
      SELECT gen_random_uuid(), encode(sha256(convert_to('device-capacity-' || gen_random_uuid()::text, 'UTF8')), 'hex'), encode(sha256(convert_to('user-capacity-' || gen_random_uuid()::text, 'UTF8')), 'hex'), ${identity.publicKeySpki}, ${identity.fingerprint}, 'linux', '0.0.1', ${now}, ${now + 900000}, ${now} FROM generate_series(1, ${999 - active})`
    const capacity = await Promise.all([
      pairing.start({
        public_key_spki: identity.publicKeySpki,
        platform: 'linux',
        version: '0.0.1',
      }),
      pairing.start({
        public_key_spki: identity.publicKeySpki,
        platform: 'linux',
        version: '0.0.1',
      }),
    ])
    assert.equal(capacity.filter((x) => x.ok).length, 1)
    assert.equal(
      capacity.filter((x) => !x.ok && x.reason === 'capacity').length,
      1,
    )
    now += 900000
    assert.equal((await start()).issued_at, now)
    checks.push(
      'global-active-capacity-serializes-concurrent-start-and-expired-rows-release-capacity',
    )
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
  assert.deepEqual(
    await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    }),
    { ok: false, reason: 'storage-unavailable' },
  )
  return [...checks, 'closed-storage-fails-closed']
}
