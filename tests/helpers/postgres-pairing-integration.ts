import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'

/** Caller owns disposable loopback DB and migrations 0001–0009; rows remain for caller teardown. */
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
  const config = {
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pairing',
  }
  const pairing = new PostgresPairing(sql, config, () => now)
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const checks: string[] = []
  async function start(proven = true) {
    const result = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('Pairing start failed')
    if (proven) await prove(result.response)
    return result.response
  }
  async function prove(
    code: { device_code: string },
    origin = config.origin,
    audience = config.audience,
  ) {
    const source = new PostgresPairingProof(
      admin,
      { origin, audience },
      () => now,
    )
    const proof = await source.issue({
      device_code: code.device_code,
    })
    if (!proof.ok) throw new Error('Fixture proof issuance failed')
    const completed = await source.complete({
      device_code: code.device_code,
      challenge: proof.challenge,
      signature: identity.signPairingProof({
        challenge: proof.challenge,
        expectedOrigin: origin,
        expectedAudience: audience,
        now,
      }),
    })
    if (!completed.ok) throw new Error('Fixture proof verification failed')
    return proof.challenge
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
    const absent = await start(false)
    const absentOwner = await member()
    assert.deepEqual(await decision(absent, absentOwner), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.connector_enrollments WHERE farm_id = ${absentOwner.farmId}::uuid`
      )[0]?.n,
      0,
    )
    // Legacy pre-gate approved rows must not bypass a missing proof at claim.
    await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) SELECT agent_id, ${absentOwner.farmId}::uuid, public_key_spki, fingerprint FROM farm.pairing_requests WHERE user_code_hash = encode(sha256(convert_to(${absent.user_code}, 'UTF8')), 'hex')`
    await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE farm_id = ${absentOwner.farmId}::uuid`
    await admin`UPDATE farm.pairing_requests SET status = 'approved', farm_id = ${absentOwner.farmId}::uuid, decided_by = ${absentOwner.sessionRecordId} WHERE user_code_hash = encode(sha256(convert_to(${absent.user_code}, 'UTF8')), 'hex')`
    assert.deepEqual(await pairing.claim({ device_code: absent.device_code }), {
      ok: false,
      reason: 'denied',
    })
    const wrongPairing = await start(false)
    await start() // A verified proof on a different pairing cannot authorize this request.
    assert.deepEqual(await decision(wrongPairing, await member()), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await pairing.claim({ device_code: absent.device_code }), {
      ok: false,
      reason: 'denied',
    })
    const wrongOrigin = await start(false)
    await prove(wrongOrigin, 'https://other.example')
    assert.deepEqual(await decision(wrongOrigin, await member()), {
      ok: false,
      reason: 'denied',
    })
    const wrongAudience = await start(false)
    await prove(wrongAudience, config.origin, 'another:audience')
    assert.deepEqual(await decision(wrongAudience, await member()), {
      ok: false,
      reason: 'denied',
    })
    const ownOriginCode = await start()
    const ownOriginOwner = await member()
    const wrongServer = new PostgresPairing(
      sql,
      { ...config, origin: 'https://other.example' },
      () => now,
    )
    const ownRequest = {
      decision: 'approve' as const,
      ...ownOriginOwner,
      request: {
        user_code: ownOriginCode.user_code,
        farm_id: ownOriginOwner.farmId,
        expected_fingerprint: ownOriginCode.fingerprint,
      },
    }
    assert.deepEqual(await wrongServer.decide(ownRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.equal((await decision(ownOriginCode, ownOriginOwner)).ok, true)
    assert.deepEqual(
      await wrongServer.claim({ device_code: ownOriginCode.device_code }),
      { ok: false, reason: 'denied' },
    )
    assert.equal(
      (await pairing.claim({ device_code: ownOriginCode.device_code })).ok,
      true,
    )
    checks.push(
      'missing-wrong-pairing-origin-audience-proofs-deny-approval-and-legacy-claim',
    )

    const expiringApproval = await start(false)
    const approvalProof = await prove(expiringApproval)
    const approvalOwner = await member()
    now = approvalProof.expires_at
    assert.deepEqual(await decision(expiringApproval, approvalOwner), {
      ok: false,
      reason: 'denied',
    })
    now -= 1
    assert.deepEqual(await decision(expiringApproval, approvalOwner), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await decision(expiringApproval, approvalOwner, 'deny'), {
      ok: true,
      status: 'denied',
    })
    const expiringClaim = await start(false)
    const claimProof = await prove(expiringClaim)
    assert.equal((await decision(expiringClaim, await member())).ok, true)
    now = claimProof.expires_at
    assert.deepEqual(
      await pairing.claim({ device_code: expiringClaim.device_code }),
      { ok: false, reason: 'denied' },
    )
    now -= 1
    assert.deepEqual(
      await pairing.claim({ device_code: expiringClaim.device_code }),
      { ok: false, reason: 'denied' },
    )
    checks.push(
      'proof-validity-required-at-both-stages-and-observed-expiry-survives-clock-regression',
    )

    for (const stage of ['approval', 'claim']) {
      const code = await start(false)
      const challenge = await prove(code)
      const subject = await member()
      if (stage === 'claim')
        assert.equal((await decision(code, subject)).ok, true)
      const gate = await admin.reserve()
      await gate`BEGIN`
      await gate`SELECT agent_id FROM farm.pairing_proofs WHERE nonce = ${challenge.nonce} FOR UPDATE`
      const operation =
        stage === 'approval'
          ? decision(code, subject)
          : pairing.claim({ device_code: code.device_code })
      try {
        await waitForLock('FROM farm.pairing_proofs')
        now = challenge.expires_at
      } finally {
        await gate`COMMIT`
        gate.release()
      }
      assert.deepEqual(await operation, { ok: false, reason: 'denied' })
      if (stage === 'approval')
        assert.equal(
          (
            await admin`SELECT count(*)::int AS n FROM farm.connector_enrollments WHERE farm_id = ${subject.farmId}::uuid`
          )[0]?.n,
          0,
        )
    }
    const sessionProofCode = await start(false)
    const sessionProof = await prove(sessionProofCode)
    const sessionProofOwner = await member()
    sessionProofOwner.policy.idleTimeoutMs = 10
    const sessionProofGate = await admin.reserve()
    await sessionProofGate`BEGIN`
    await sessionProofGate`SELECT agent_id FROM farm.pairing_proofs WHERE nonce = ${sessionProof.nonce} FOR UPDATE`
    const sessionProofDecision = decision(sessionProofCode, sessionProofOwner)
    try {
      await waitForLock('FROM farm.pairing_proofs')
      now += 10
    } finally {
      await sessionProofGate`COMMIT`
      sessionProofGate.release()
    }
    assert.deepEqual(await sessionProofDecision, {
      ok: false,
      reason: 'denied',
    })
    assert.equal(
      Number(
        (
          await admin`SELECT revoked_at::float8 AS n FROM farm.account_sessions WHERE id = ${sessionProofOwner.sessionRecordId}`
        )[0]?.n,
      ),
      now,
    )
    now -= 10
    assert.deepEqual(await decision(sessionProofCode, sessionProofOwner), {
      ok: false,
      reason: 'denied',
    })
    checks.push(
      'session-expiry-during-proof-lock-persists-terminal-session-revocation',
    )
    const delayedCode = await start(false)
    const delayedProof = await prove(delayedCode)
    const delayedMember = await member()
    assert.equal((await decision(delayedCode, delayedMember)).ok, true)
    const enrollmentGate = await admin.reserve()
    await enrollmentGate`BEGIN`
    await enrollmentGate`SELECT agent_id FROM farm.connector_enrollments WHERE farm_id = ${delayedMember.farmId}::uuid FOR UPDATE`
    const delayedClaim = pairing.claim({ device_code: delayedCode.device_code })
    try {
      await waitForLock('SELECT status, farm_id')
      now = delayedProof.expires_at
    } finally {
      await enrollmentGate`COMMIT`
      enrollmentGate.release()
    }
    assert.deepEqual(await delayedClaim, { ok: false, reason: 'denied' })
    checks.push(
      'proof-expiry-after-proof-lock-and-enrollment-lock-denies-without-partial-approval',
    )

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

    // Invalid account and session state cannot approve even a valid request.
    const guardedCode = await start()
    for (const state of ['disabled', 'version', 'revoked'] as const) {
      const subject = await member()
      if (state === 'disabled')
        await admin`UPDATE farm.session_accounts SET disabled = true WHERE id = ${subject.sessionRecordId}`
      else if (state === 'version')
        await admin`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${subject.sessionRecordId}`
      else
        await admin`UPDATE farm.account_sessions SET revoked_at = ${now} WHERE id = ${subject.sessionRecordId}`
      assert.deepEqual(await decision(guardedCode, subject), {
        ok: false,
        reason: 'denied',
      })
    }
    const actualFarmOwner = await member()
    const otherFarmOwner = await member()
    assert.deepEqual(
      await decision(guardedCode, {
        ...actualFarmOwner,
        farmId: otherFarmOwner.farmId,
      }),
      {
        ok: false,
        reason: 'denied',
      },
    )
    assert.equal((await decision(guardedCode, actualFarmOwner)).ok, true)
    checks.push('disabled-revoked-version-and-two-existing-farms-denied')

    for (const expiry of ['idle', 'absolute'] as const) {
      const code = await start()
      const subject = await member()
      const before = now
      if (expiry === 'idle') subject.policy.idleTimeoutMs = 10
      now += expiry === 'idle' ? 10 : 2000000
      assert.deepEqual(await decision(code, subject), {
        ok: false,
        reason: 'denied',
      })
      assert.equal(
        Number(
          (
            await admin`SELECT revoked_at::float8 AS revoked_at FROM farm.account_sessions WHERE id = ${subject.sessionRecordId}`
          )[0]?.revoked_at,
        ),
        now,
      )
      now = before
      assert.deepEqual(await decision(code, subject), {
        ok: false,
        reason: 'denied',
      })
    }
    checks.push(
      'idle-and-absolute-expiry-persist-revocation-across-clock-regression',
    )

    // Invalid authorization does not wait for a locked pairing request.
    const lockedCode = await start()
    const unauthorized = await member('viewer')
    const heldUnauthorized = await admin.reserve()
    await heldUnauthorized`BEGIN`
    await heldUnauthorized`SELECT agent_id FROM farm.pairing_requests WHERE user_code_hash = encode(sha256(convert_to(${lockedCode.user_code}, 'UTF8')), 'hex') FOR UPDATE`
    try {
      assert.deepEqual(await decision(lockedCode, unauthorized), {
        ok: false,
        reason: 'denied',
      })
    } finally {
      await heldUnauthorized`ROLLBACK`
      heldUnauthorized.release()
    }
    const nearExpiry = await start()
    now = nearExpiry.expires_at - 1
    assert.equal(
      (await pairing.claim({ device_code: nearExpiry.device_code })).ok,
      true,
    )
    assert.equal(
      Number(
        (
          await admin`SELECT next_poll_at::float8 AS n FROM farm.pairing_requests WHERE device_code_hash = encode(sha256(convert_to(${nearExpiry.device_code}, 'UTF8')), 'hex')`
        )[0]?.n,
      ),
      nearExpiry.expires_at,
    )
    checks.push('authorization-before-request-lock-and-poll-clamped-to-expiry')

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
    const downgradeCode = await start()
    const downgradeOwner = await member()
    const downgradeGate = await admin.reserve()
    await downgradeGate`BEGIN`
    await downgradeGate`UPDATE farm.memberships SET role = 'viewer' WHERE farm_id = ${downgradeOwner.farmId}::uuid`
    const downgrade = decision(downgradeCode, downgradeOwner)
    try {
      await waitForLock('SELECT role, revoked_at')
    } finally {
      await downgradeGate`COMMIT`
      downgradeGate.release()
    }
    assert.deepEqual(await downgrade, { ok: false, reason: 'denied' })
    const sessionWaitCode = await start()
    const sessionWaitOwner = await member()
    sessionWaitOwner.policy.idleTimeoutMs = 10
    const sessionGate = await admin.reserve()
    await sessionGate`BEGIN`
    await sessionGate`SELECT agent_id FROM farm.pairing_requests WHERE user_code_hash = encode(sha256(convert_to(${sessionWaitCode.user_code}, 'UTF8')), 'hex') FOR UPDATE`
    const sessionWait = decision(sessionWaitCode, sessionWaitOwner)
    try {
      await waitForLock('FROM farm.pairing_requests')
      now += 10
    } finally {
      await sessionGate`COMMIT`
      sessionGate.release()
    }
    assert.deepEqual(await sessionWait, { ok: false, reason: 'denied' })
    assert.equal(
      Number(
        (
          await admin`SELECT revoked_at::float8 AS revoked_at FROM farm.account_sessions WHERE id = ${sessionWaitOwner.sessionRecordId}`
        )[0]?.revoked_at,
      ),
      now,
    )
    now -= 10
    assert.deepEqual(await decision(sessionWaitCode, sessionWaitOwner), {
      ok: false,
      reason: 'denied',
    })
    checks.push('role-downgrade-and-session-expiry-during-lock-wait')
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
      "UPDATE farm.pairing_proofs SET status = 'verified'",
      'UPDATE farm.pairing_requests SET proof_expired_at = NULL WHERE proof_expired_at IS NOT NULL',
      'CREATE TABLE farm.forbidden_pairing (id int)',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.pairing_requests SET user_code_hash = repeat('b',64) WHERE agent_id = (SELECT agent_id FROM farm.pairing_requests LIMIT 1)`,
    )
    await assert.rejects(
      admin`UPDATE farm.pairing_requests SET proof_expired_at = NULL WHERE proof_expired_at IS NOT NULL`,
    )
    await assert.rejects(
      admin`UPDATE farm.pairing_requests SET proof_expired_at = proof_expired_at + 1 WHERE proof_expired_at IS NOT NULL`,
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
