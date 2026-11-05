import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import { PostgresEnrollmentSource } from '../../apps/farm/server/storage/postgres-enrollment.ts'
import { EnrolledConnectorProof } from '../../apps/farm/server/services/enrolled-connector-proof.ts'
import { verifyConnectorCredential } from '../../apps/farm/server/utils/connector-credentials.ts'

/** Synthetic caller-owned fixture through migration 0011. No tokens, secrets or printer commands in output. */
export async function testPostgresConnectorRevocation(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const role = 'revocation_fixture_' + randomUUID().replaceAll('-', '')
  const claimRole = role + '_claim'
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_revoker`
  await admin`CREATE ROLE ${admin(claimRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pairing_runtime`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 8,
    connect_timeout: 3,
    connection: { application_name: role },
  })
  const claimSql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: claimRole,
    max: 6,
    connect_timeout: 3,
    connection: { application_name: claimRole },
  })
  const config = {
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pairing',
  }
  let now =
    Number(
      (
        await admin`SELECT coalesce(max(expires_at),0)::float8 AS n FROM farm.pairing_requests`
      )[0]?.n,
    ) + 100000
  const pairing = new PostgresPairing(claimSql, config, () => now)
  const source = new PostgresPairingProof(admin, config, () => now)
  const revoke = new PostgresConnectorRevocation(sql, () => now)
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  if (!('privateKey' in keys)) throw new Error('Expected signing key pair')
  const issuer = {
    issuer: config.origin,
    audience: 'open3dfarmmanager:connector',
    kid: 'fixture-key-1',
    privateKey: keys.privateKey,
    ttlSeconds: 300,
  }
  const checks: string[] = []
  async function actor(role = 'owner', farmId = randomUUID()) {
    const id = randomUUID()
    await admin`INSERT INTO farm.session_accounts(id) VALUES(${id})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${id},${id},0,${now},${now},${now + 2000000})`
    await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid) ON CONFLICT DO NOTHING`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${id},${role})`
    return { sessionRecordId: id, policy: { idleTimeoutMs: 2000000 }, farmId }
  }
  async function prepare(member?: Awaited<ReturnType<typeof actor>>) {
    const subject = member ?? (await actor())
    const started = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    if (!started.ok) throw new Error('Fixture pairing start failed')
    const challenge = await source.issue({
      device_code: started.response.device_code,
    })
    if (!challenge.ok) throw new Error('Fixture challenge failed')
    assert.equal(
      (
        await source.complete({
          device_code: started.response.device_code,
          challenge: challenge.challenge,
          signature: identity.signPairingProof({
            challenge: challenge.challenge,
            expectedOrigin: config.origin,
            expectedAudience: config.audience,
            now,
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
            user_code: started.response.user_code,
            farm_id: subject.farmId,
            expected_fingerprint: identity.fingerprint,
          },
        })
      ).ok,
      true,
    )
    return {
      subject,
      agentId: challenge.challenge.agent_id,
      farmId: subject.farmId,
      expectedFingerprint: identity.fingerprint,
      device: { device_code: started.response.device_code },
      userCode: started.response.user_code,
      proofExpiresAt: challenge.challenge.expires_at,
    }
  }
  function request(
    item: Pick<
      Awaited<ReturnType<typeof prepare>>,
      'subject' | 'agentId' | 'expectedFingerprint'
    >,
    subject = item.subject,
  ) {
    return {
      ...subject,
      agentId: item.agentId,
      expectedFingerprint: item.expectedFingerprint,
    }
  }
  async function status(item: { agentId: string }) {
    return (
      await admin`SELECT status FROM farm.connector_enrollments WHERE agent_id=${item.agentId}::uuid`
    )[0]?.status
  }
  async function tombstone(item: { agentId: string }) {
    return (
      await admin`SELECT agent_id,farm_id,fingerprint,credential_jti,revoked_at::float8,revoked_by FROM farm.connector_revocations WHERE agent_id=${item.agentId}::uuid`
    )[0]
  }
  async function waiting(fragment: string, includeAdmin = false) {
    const deadline = performance.now() + 750
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND (application_name IN (${role},${claimRole}) OR ${includeAdmin}) AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (rows[0]?.n > 0) return
      assert.ok(performance.now() < deadline, 'Expected lock wait ' + fragment)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  async function installPause(
    table: 'connector_credentials' | 'connector_revocations',
  ) {
    await admin
      .unsafe(
        `CREATE FUNCTION farm.pause_revocation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1870011,7); RETURN NEW; END; $$; CREATE TRIGGER pause_revocation_fixture BEFORE INSERT ON farm.${table} FOR EACH ROW EXECUTE FUNCTION farm.pause_revocation_fixture();`,
      )
      .simple()
  }
  async function removePause(
    table: 'connector_credentials' | 'connector_revocations',
  ) {
    await admin
      .unsafe(
        `DROP TRIGGER pause_revocation_fixture ON farm.${table}; DROP FUNCTION farm.pause_revocation_fixture();`,
      )
      .simple()
  }
  try {
    const orphan = await prepare()
    now = orphan.proofExpiresAt
    assert.deepEqual(await pairing.claim(orphan.device, issuer), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await revoke.revoke(request(orphan)), {
      ok: true,
      status: 'revoked',
      credential: 'not-issued',
      revokedAt: now,
    })
    assert.equal(await status(orphan), 'revoked')
    const first = await tombstone(orphan)
    assert.equal(first?.credential_jti, null)
    assert.equal(first?.revoked_by, orphan.subject.sessionRecordId)
    const adminActor = await actor('admin', orphan.farmId)
    now += 1
    assert.deepEqual(await revoke.revoke(request(orphan, adminActor)), {
      ok: true,
      status: 'revoked',
      credential: 'not-issued',
      revokedAt: first?.revoked_at,
    })
    assert.deepEqual(await tombstone(orphan), first)
    assert.deepEqual(
      await revoke.revoke(
        request(orphan, await actor('viewer', orphan.farmId)),
      ),
      { ok: false, reason: 'denied' },
    )
    checks.push(
      'expired-proof-orphan-cleanup-first-tombstone-idempotent-only-after-fresh-farm-authorization',
    )

    const legacyActor = await actor()
    const legacy = {
      subject: legacyActor,
      farmId: legacyActor.farmId,
      agentId: randomUUID(),
      expectedFingerprint: identity.fingerprint,
    }
    await admin`INSERT INTO farm.connector_enrollments (agent_id,farm_id,public_key_spki,fingerprint) VALUES (${legacy.agentId}::uuid,${legacy.farmId}::uuid,${identity.publicKeySpki},${identity.fingerprint})`
    await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${legacy.agentId}::uuid`
    assert.equal((await revoke.revoke(request(legacy))).ok, true)
    assert.equal(await status(legacy), 'revoked')
    assert.equal((await tombstone(legacy))?.credential_jti, null)
    checks.push(
      'legacy-approved-enrollment-without-pairing-is-terminally-revoked',
    )

    const issued = await prepare()
    const claimed = await pairing.claim(issued.device, issuer)
    if (!claimed.ok || claimed.status !== 'approved')
      throw new Error('Fixture credential failed')
    const metadataBefore = (
      await admin`SELECT row_to_json(c)::text AS value FROM farm.connector_credentials c WHERE agent_id=${issued.agentId}::uuid`
    )[0]?.value
    const verified = await verifyConnectorCredential({
      token: claimed.device_token,
      issuer: issuer.issuer,
      audience: issuer.audience,
      publicKeys: new Map([[issuer.kid, keys.publicKey]]),
      ttlSeconds: issuer.ttlSeconds,
      nowSeconds: Math.floor(now / 1000),
      agentId: issued.agentId,
      farmId: issued.farmId,
      publicKeySpki: identity.publicKeySpki,
    })
    assert.equal((await revoke.revoke(request(issued))).ok, true)
    assert.equal((await tombstone(issued))?.credential_jti, verified.jti)
    assert.equal(
      (
        await admin`SELECT row_to_json(c)::text AS value FROM farm.connector_credentials c WHERE agent_id=${issued.agentId}::uuid`
      )[0]?.value,
      metadataBefore,
    )
    // Revocation is current server state; it does not erase cryptographic signature validity or an offline key.
    assert.equal(
      (
        await verifyConnectorCredential({
          token: claimed.device_token,
          issuer: issuer.issuer,
          audience: issuer.audience,
          publicKeys: new Map([[issuer.kid, keys.publicKey]]),
          ttlSeconds: issuer.ttlSeconds,
          nowSeconds: Math.floor(now / 1000),
          agentId: issued.agentId,
          farmId: issued.farmId,
          publicKeySpki: identity.publicKeySpki,
        })
      ).jti,
      verified.jti,
    )
    const online = new EnrolledConnectorProof(new PostgresEnrollmentSource(sql))
    assert.equal(
      await online.issue(
        { agentId: issued.agentId, farmId: issued.farmId },
        randomUUID(),
        () => now,
        1000,
      ),
      null,
    )
    assert.deepEqual(await pairing.claim(issued.device, issuer), {
      ok: false,
      reason: 'denied',
    })
    const replacement = await prepare(issued.subject)
    assert.notEqual(replacement.agentId, issued.agentId)
    assert.equal((await pairing.claim(replacement.device, issuer)).ok, true)
    checks.push(
      'issued-lost-response-jti-revocation-preserves-metadata-old-online-proof-denied-fresh-agent-required',
    )

    const guarded = await prepare()
    for (const actorRole of ['operator', 'viewer'])
      assert.deepEqual(
        await revoke.revoke(
          request(guarded, await actor(actorRole, guarded.farmId)),
        ),
        { ok: false, reason: 'denied' },
      )
    for (const patch of [
      { farmId: (await actor()).farmId },
      { agentId: randomUUID() },
      { expectedFingerprint: 'SHA256:' + 'A'.repeat(43) },
      { sessionRecordId: 'missing-session' },
    ])
      assert.deepEqual(await revoke.revoke({ ...request(guarded), ...patch }), {
        ok: false,
        reason: 'denied',
      })
    assert.deepEqual(
      await revoke.revoke({ ...request(guarded), agentId: guarded.userCode }),
      { ok: false, reason: 'invalid-input' },
    )
    assert.equal(await status(guarded), 'approved')
    const unauthorized = await actor('viewer', guarded.farmId)
    const targetLock = await admin.reserve()
    await targetLock`BEGIN`
    await targetLock`SELECT agent_id FROM farm.pairing_requests WHERE agent_id=${guarded.agentId}::uuid FOR UPDATE`
    try {
      assert.deepEqual(await revoke.revoke(request(guarded, unauthorized)), {
        ok: false,
        reason: 'denied',
      })
    } finally {
      await targetLock`ROLLBACK`
      targetLock.release()
    }
    checks.push(
      'current-owner-admin-only-exact-farm-agent-fingerprint-no-code-authority-no-unauthorized-target-lock',
    )

    for (const kind of [
      'disabled',
      'version',
      'session',
      'membership',
      'downgrade',
    ]) {
      const item = await prepare(),
        blocker = await admin.reserve()
      await blocker`BEGIN`
      if (kind === 'membership')
        await blocker`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${item.farmId}::uuid AND account_id=${item.subject.sessionRecordId}`
      else if (kind === 'downgrade')
        await blocker`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${item.farmId}::uuid AND account_id=${item.subject.sessionRecordId}`
      else {
        await blocker`SELECT id FROM farm.session_accounts WHERE id=${item.subject.sessionRecordId} FOR UPDATE`
        if (kind === 'disabled')
          await blocker`UPDATE farm.session_accounts SET disabled=true WHERE id=${item.subject.sessionRecordId}`
        else if (kind === 'version')
          await blocker`UPDATE farm.session_accounts SET session_version=session_version+1 WHERE id=${item.subject.sessionRecordId}`
        else
          await blocker`UPDATE farm.account_sessions SET revoked_at=${now} WHERE id=${item.subject.sessionRecordId}`
      }
      const operation = revoke.revoke(request(item))
      try {
        await waiting(
          kind === 'membership' || kind === 'downgrade'
            ? 'SELECT role, revoked_at'
            : 'SELECT id, session_version',
        )
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      assert.deepEqual(await operation, { ok: false, reason: 'denied' })
      assert.equal(await status(item), 'approved')
      assert.equal(await tombstone(item), undefined)
    }
    checks.push(
      'account-session-membership-revocation-and-downgrade-committed-before-revoke-deny',
    )

    for (const kind of [
      'disabled',
      'version',
      'session',
      'membership',
      'downgrade',
    ]) {
      const item = await prepare()
      await installPause('connector_revocations')
      const gate = await admin.reserve()
      await gate`SELECT pg_advisory_lock(1870011,7)`
      const operation = revoke.revoke(request(item))
      let mutation: PromiseLike<unknown> | undefined
      try {
        await waiting('INSERT INTO farm.connector_revocations')
        if (kind === 'membership')
          mutation =
            admin`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${item.farmId}::uuid AND account_id=${item.subject.sessionRecordId}`.execute()
        else if (kind === 'downgrade')
          mutation =
            admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${item.farmId}::uuid AND account_id=${item.subject.sessionRecordId}`.execute()
        else if (kind === 'session')
          mutation = new PostgresSessionRepository(admin).revokeSession(
            item.subject.sessionRecordId,
            now,
          )
        else if (kind === 'version')
          mutation = new PostgresSessionRepository(admin).revokeAccountSessions(
            item.subject.sessionRecordId,
          )
        else
          mutation =
            admin`UPDATE farm.session_accounts SET disabled=true WHERE id=${item.subject.sessionRecordId}`.execute()
        await waiting(
          kind === 'membership' || kind === 'downgrade'
            ? 'UPDATE farm.memberships'
            : kind === 'session'
              ? 'SELECT id FROM farm.session_accounts'
              : 'UPDATE farm.session_accounts',
          true,
        )
      } finally {
        await gate`SELECT pg_advisory_unlock(1870011,7)`
        gate.release()
      }
      try {
        assert.equal((await operation).ok, true)
        await mutation
        assert.equal(await status(item), 'revoked')
        assert.deepEqual(await revoke.revoke(request(item)), {
          ok: false,
          reason: 'denied',
        })
      } finally {
        await removePause('connector_revocations')
      }
    }
    checks.push(
      'cleanup-first-retains-authorization-locks-until-commit-before-later-account-session-membership-revocation',
    )

    for (const order of ['claim-first', 'revoke-first']) {
      const item = await prepare(),
        table =
          order === 'claim-first'
            ? 'connector_credentials'
            : 'connector_revocations'
      await installPause(table)
      const gate = await admin.reserve()
      await gate`SELECT pg_advisory_lock(1870011,7)`
      const firstOperation =
        order === 'claim-first'
          ? pairing.claim(item.device, issuer)
          : revoke.revoke(request(item))
      let secondOperation:
        | ReturnType<typeof pairing.claim>
        | ReturnType<typeof revoke.revoke>
        | undefined
      try {
        await waiting('INSERT INTO farm.' + table)
        secondOperation =
          order === 'claim-first'
            ? revoke.revoke(request(item))
            : pairing.claim(item.device, issuer)
        await waiting('FROM farm.pairing_requests')
      } finally {
        await gate`SELECT pg_advisory_unlock(1870011,7)`
        gate.release()
      }
      try {
        const firstResult = await firstOperation,
          secondResult = await secondOperation
        assert.ok(firstResult.ok)
        if (order === 'claim-first') {
          assert.equal(firstResult.status, 'approved')
          assert.ok(secondResult?.ok && secondResult.status === 'revoked')
          assert.notEqual((await tombstone(item))?.credential_jti, null)
        } else {
          assert.equal(firstResult.status, 'revoked')
          assert.deepEqual(secondResult, { ok: false, reason: 'denied' })
          assert.equal((await tombstone(item))?.credential_jti, null)
        }
        assert.equal(await status(item), 'revoked')
      } finally {
        await removePause(table)
      }
    }
    checks.push(
      'both-real-claim-revocation-race-orders-one-issued-jti-or-no-issuance-no-reset',
    )

    for (const phase of ['pairing-wait', 'post-write']) {
      const item = await prepare()
      item.subject.policy.idleTimeoutMs = 10
      const gate = await admin.reserve()
      if (phase === 'pairing-wait') {
        await gate`BEGIN`
        await gate`SELECT agent_id FROM farm.pairing_requests WHERE agent_id=${item.agentId}::uuid FOR UPDATE`
      } else {
        await installPause('connector_revocations')
        await gate`SELECT pg_advisory_lock(1870011,7)`
      }
      const operation = revoke.revoke(request(item))
      try {
        await waiting(
          phase === 'pairing-wait'
            ? 'FROM farm.pairing_requests'
            : 'INSERT INTO farm.connector_revocations',
        )
        now += 10
      } finally {
        if (phase === 'pairing-wait') await gate`COMMIT`
        else await gate`SELECT pg_advisory_unlock(1870011,7)`
        gate.release()
      }
      try {
        assert.deepEqual(await operation, { ok: false, reason: 'denied' })
        assert.equal(await status(item), 'approved')
        assert.equal(await tombstone(item), undefined)
        assert.equal(
          Number(
            (
              await admin`SELECT revoked_at::float8 AS n FROM farm.account_sessions WHERE id=${item.subject.sessionRecordId}`
            )[0]?.n,
          ),
          now,
        )
        now -= 10
        assert.deepEqual(await revoke.revoke(request(item)), {
          ok: false,
          reason: 'denied',
        })
      } finally {
        if (phase === 'post-write') await removePause('connector_revocations')
      }
    }
    checks.push(
      'expiry-after-target-wait-and-post-write-rolls-back-cleanup-persists-session-expiry-across-clock-regression',
    )

    const failure = await prepare()
    await admin
      .unsafe(
        `CREATE FUNCTION farm.fail_revocation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_revocation_fixture AFTER INSERT ON farm.connector_revocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_revocation_fixture();`,
      )
      .simple()
    try {
      assert.deepEqual(await revoke.revoke(request(failure)), {
        ok: false,
        reason: 'storage-unavailable',
      })
      assert.equal(await status(failure), 'approved')
      assert.equal(await tombstone(failure), undefined)
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_revocation_fixture ON farm.connector_revocations; DROP FUNCTION farm.fail_revocation_fixture();',
        )
        .simple()
    }
    assert.equal((await revoke.revoke(request(failure))).ok, true)
    checks.push(
      'commit-failure-rolls-back-enrollment-and-tombstone-before-success-and-known-rollback-retry',
    )

    assert.equal(
      (
        await sql`SELECT has_table_privilege(current_user, 'farm.connector_credentials', 'INSERT') AS allowed`
      )[0]?.allowed,
      false,
    )
    for (const query of [
      'DELETE FROM farm.connector_revocations',
      'TRUNCATE farm.connector_revocations',
      'UPDATE farm.connector_revocations SET revoked_at=revoked_at+1',
      'UPDATE farm.connector_credentials SET jti=jti',
      "UPDATE farm.memberships SET role='owner'",
      'UPDATE farm.session_accounts SET disabled=false',
      'CREATE TABLE farm.forbidden_revocation(id int)',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.connector_revocations SET revoked_by=${adminActor.sessionRecordId} WHERE agent_id=${orphan.agentId}::uuid`,
    )
    checks.push(
      'immutable-first-tombstones-and-credential-metadata-restricted-role-no-escalation',
    )
  } finally {
    await Promise.all([sql.end({ timeout: 3 }), claimSql.end({ timeout: 3 })])
    await admin`DROP ROLE ${admin(claimRole)}`
    await admin`DROP ROLE ${admin(role)}`
  }
  return checks
}
