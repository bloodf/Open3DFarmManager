import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import {
  PostgresConnectorCredentialAcceptance,
  type CredentialAcceptanceDecision,
} from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import {
  type CredentialProofRequest,
  type CredentialProofChallenge,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import { issueConnectorCredential } from '../../apps/farm/server/utils/connector-credentials.ts'

/** Caller-owned disposable fixture with official migrations through 0014. No tokens in output. */
export async function testPostgresCredentialAcceptance(
  admin: Sql,
  port: number,
  restartFixturePath?: string,
): Promise<string[]> {
  const role = 'acceptance_fixture_' + randomUUID().replaceAll('-', '')
  const claimRole = role + '_claim',
    revokerRole = role + '_revoke'
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_acceptor`
  await admin`CREATE ROLE ${admin(claimRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pairing_runtime`
  await admin`CREATE ROLE ${admin(revokerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_revoker`
  const connect = (user: string) =>
    postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: user,
      max: 6,
      connect_timeout: 3,
      connection: { application_name: user },
    })
  const sql = connect(role),
    claimSql = connect(claimRole),
    revocationSql = connect(revokerRole)
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
  const revoke = new PostgresConnectorRevocation(revocationSql, () => now)
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
  const acceptanceConfig = {
    issuer: issuer.issuer,
    audience: issuer.audience,
    origin: config.origin,
    purpose: 'signalling',
    publicKeys: new Map([[issuer.kid, keys.publicKey]]),
    ttlSeconds: issuer.ttlSeconds,
    proofTtlMs: 30000,
  } satisfies ConstructorParameters<
    typeof PostgresConnectorCredentialAcceptance
  >[1]
  const acceptor = () =>
    new PostgresConnectorCredentialAcceptance(sql, acceptanceConfig, () => now)
  async function issued() {
    const item = await prepare()
    const result = await pairing.claim(item.device, issuer)
    if (!result.ok || result.status !== 'approved')
      throw new Error('Fixture claim failed')
    const request = {
      token: result.device_token,
      agentId: item.agentId,
      farmId: item.farmId,
      connectionId: randomUUID(),
    }
    const credential = (
      await admin`SELECT jti,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=${item.agentId}::uuid`
    )[0]
    if (!credential) throw new Error('Fixture metadata missing')
    return { ...item, request, credential }
  }
  async function challenge(
    request: CredentialProofRequest,
    service = acceptor(),
  ) {
    const result = await service.issue(request)
    if (!result.ok || result.kind !== 'challenge')
      throw new Error(
        'Fixture challenge failed: ' +
          (result.ok ? result.kind : result.reason),
      )
    return result.challenge
  }
  function signed(
    request: CredentialProofRequest,
    challenge: CredentialProofChallenge,
  ) {
    return {
      ...request,
      challenge,
      signature: identity.signCredentialProof({
        challenge,
        token: request.token,
        expectedOrigin: config.origin,
        expectedAudience: issuer.audience,
        expectedPurpose: acceptanceConfig.purpose,
        expectedConnectionId: request.connectionId,
        now,
      }),
    }
  }
  const accepted = (result: CredentialAcceptanceDecision) =>
    result.ok && result.kind === 'accepted'
  const slot = async (jti: string) =>
    (
      await admin`SELECT generation::float8,observed_at::float8,credential_expired_at::float8,status,failures,nonce,next_attempt_at::float8 FROM farm.connector_credential_proofs WHERE jti=${jti}::uuid`
    )[0]
  async function waiting(fragment: string, application = role) {
    const end = performance.now() + 750
    while (true) {
      if (
        (
          await admin`SELECT 1 FROM pg_stat_activity WHERE application_name=${application} AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
        ).length
      )
        return
      assert.ok(performance.now() < end, 'Expected bounded fixture lock wait')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    const item = await issued()
    const first = await challenge(item.request)
    const throttled = await acceptor().issue(item.request)
    assert.ok(
      !throttled.ok &&
        throttled.reason === 'busy' &&
        throttled.retryAfterMs === 1000,
    )
    now += 1000
    assert.deepEqual(
      await challenge(item.request, acceptor()),
      first,
      'New process/service reuses persisted pending proof',
    )
    now += 1000
    const other = { ...item.request, connectionId: randomUUID() }
    const occupied = await acceptor().issue(other)
    assert.ok(
      !occupied.ok && occupied.reason === 'busy' && occupied.retryAfterMs > 0,
    )
    now += 1000
    const proof = signed(item.request, first)
    const results = await Promise.all([
      acceptor().accept(proof),
      acceptor().accept(proof),
    ])
    assert.equal(results.filter(accepted).length, 1)
    const success = results.find(accepted)
    assert.ok(success?.ok && success.kind === 'accepted')
    assert.equal(success.connectionId, item.request.connectionId)
    assert.equal(success.jti, item.credential.jti)
    assert.equal(success.expiresAt, first.expires_at)
    now += 1000
    assert.equal(accepted(await acceptor().accept(proof)), false)
    assert.equal((await slot(item.credential.jti))?.status, 'consumed')
    checks.push(
      'actual-jose-live-identity-persisted-cross-instance-challenge-single-concurrent-acceptance-context-bound-receipt-replay-denied',
    )

    const protectedItem = await issued()
    const pending = await challenge(protectedItem.request)
    now += 1000
    assert.equal((await acceptor().accept(protectedItem.request)).ok, false)
    const signatureStart = protectedItem.request.token.lastIndexOf('.') + 1
    const alteredToken =
      protectedItem.request.token.slice(0, signatureStart) +
      (protectedItem.request.token[signatureStart] === 'A' ? 'B' : 'A') +
      protectedItem.request.token.slice(signatureStart + 1)
    assert.notEqual(alteredToken, protectedItem.request.token)
    for (const patch of [
      { farmId: randomUUID() },
      { agentId: randomUUID() },
      { token: alteredToken },
    ]) {
      now += 1000
      assert.equal(
        (await acceptor().issue({ ...protectedItem.request, ...patch })).ok,
        false,
      )
    }
    for (const patch of [
      { origin: 'https://other.example' },
      { audience: 'other' },
      { issuer: 'https://other.example' },
      { purpose: 'telemetry-ingestion' },
    ] satisfies Partial<
      ConstructorParameters<typeof PostgresConnectorCredentialAcceptance>[1]
    >[]) {
      now += 1000
      const different = new PostgresConnectorCredentialAcceptance(
        sql,
        { ...acceptanceConfig, ...patch },
        () => now,
      )
      assert.equal(
        accepted(
          await different.accept(signed(protectedItem.request, pending)),
        ),
        false,
      )
    }
    for (const patch of [
      { connectionId: randomUUID() },
      {
        challenge: { ...pending, nonce: randomBytes(32).toString('base64url') },
      },
      { challenge: { ...pending, origin: 'https://other.example' } },
      { challenge: { ...pending, purpose: 'telemetry-ingestion' } },
    ]) {
      now += 1000
      assert.equal(
        accepted(
          await acceptor().accept({
            ...signed(protectedItem.request, pending),
            ...patch,
          }),
        ),
        false,
      )
    }
    assert.equal((await slot(protectedItem.credential.jti))?.status, 'pending')
    assert.equal((await slot(protectedItem.credential.jti))?.failures, 0)
    now += 1000
    assert.equal(
      accepted(await acceptor().accept(signed(protectedItem.request, pending))),
      true,
    )
    checks.push(
      'token-alone-altered-token-wrong-farm-agent-origin-audience-purpose-context-nonce-denied-without-burning-unrelated-proof',
    )

    const mismatched = await issued()
    const forged = await issueConnectorCredential({
      ...issuer,
      nowSeconds: Math.floor(now / 1000),
      agentId: mismatched.agentId,
      farmId: mismatched.farmId,
      publicKeySpki: identity.publicKeySpki,
      jti: randomUUID(),
    })
    assert.equal(
      (await acceptor().issue({ ...mismatched.request, token: forged })).ok,
      false,
    )
    checks.push(
      'cryptographically-valid-but-unissued-jti-denied-against-exact-immutable-metadata',
    )

    const attempts = await issued()
    const attempted = await challenge(attempts.request)
    for (let i = 0; i < 3; i++) {
      now += 1000
      assert.equal(
        accepted(
          await acceptor().accept({
            ...signed(attempts.request, attempted),
            signature: randomBytes(64).toString('base64url'),
          }),
        ),
        false,
      )
      assert.equal((await slot(attempts.credential.jti))?.failures, i + 1)
    }
    assert.equal((await slot(attempts.credential.jti))?.status, 'rejected')
    now += 1000
    assert.equal(
      accepted(await acceptor().accept(signed(attempts.request, attempted))),
      false,
    )
    now += 1000
    const fresh = await challenge(attempts.request)
    assert.equal(fresh.generation, attempted.generation + 1)
    assert.notEqual(fresh.nonce, attempted.nonce)
    assert.ok(
      (await slot(attempts.credential.jti))?.observed_at >= attempted.issued_at,
    )
    now += 1000
    assert.equal(
      accepted(await acceptor().accept(signed(attempts.request, fresh))),
      true,
    )
    checks.push(
      'one-second-rate-three-bad-signature-budget-bounded-slot-replacement-retains-generation-watermark-and-denies-old-proof',
    )

    const expiredProof = await issued()
    const expires = await challenge(expiredProof.request)
    const expiresSignature = signed(expiredProof.request, expires)
    now = expires.expires_at
    assert.equal(accepted(await acceptor().accept(expiresSignature)), false)
    assert.equal((await slot(expiredProof.credential.jti))?.status, 'expired')
    now -= 1000
    assert.equal((await acceptor().issue(expiredProof.request)).ok, false)
    now += 2000
    assert.ok(
      (await challenge(expiredProof.request)).generation > expires.generation,
    )
    const expiredCredential = await issued()
    const expiredTokenChallenge = await challenge(expiredCredential.request)
    now = expiredCredential.credential.expires_at * 1000
    assert.equal((await acceptor().issue(expiredCredential.request)).ok, false)
    assert.notEqual(
      (await slot(expiredCredential.credential.jti))?.credential_expired_at,
      null,
    )
    now -= 1000
    assert.equal((await acceptor().issue(expiredCredential.request)).ok, false)
    assert.equal(
      (await slot(expiredCredential.credential.jti))?.nonce,
      expiredTokenChallenge.nonce,
    )
    now += 1000
    checks.push(
      'proof-expiry-replacement-and-durable-token-expiry-deny-clock-regression-without-resetting-watermark',
    )

    const commitFailure = await issued()
    const commitChallenge = await challenge(commitFailure.request)
    now += 1000
    const commitProof = signed(commitFailure.request, commitChallenge)
    await admin
      .unsafe(
        "CREATE FUNCTION farm.fail_acceptance_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic acceptance commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_acceptance_fixture AFTER UPDATE ON farm.connector_credential_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status='consumed') EXECUTE FUNCTION farm.fail_acceptance_fixture();",
      )
      .simple()
    try {
      assert.deepEqual(await acceptor().accept(commitProof), {
        ok: false,
        reason: 'storage-unavailable',
      })
      assert.equal(
        (await slot(commitFailure.credential.jti))?.status,
        'pending',
      )
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_acceptance_fixture ON farm.connector_credential_proofs; DROP FUNCTION farm.fail_acceptance_fixture();',
        )
        .simple()
    }
    assert.equal(accepted(await acceptor().accept(commitProof)), true)
    checks.push(
      'deferred-commit-failure-returns-no-acceptance-and-rolls-back-consumption-for-known-rollback-retry',
    )

    for (const phase of ['proof-lock', 'proof-write']) {
      const deadline = await issued()
      const pending = await challenge(deadline.request)
      now += 1000
      const proof = signed(deadline.request, pending)
      const gate = await admin.reserve()
      if (phase === 'proof-lock') {
        await gate`BEGIN`
        await gate`SELECT jti FROM farm.connector_credential_proofs WHERE jti=${deadline.credential.jti}::uuid FOR UPDATE`
      } else {
        await gate`SELECT pg_advisory_lock(1870014,99)`
        await admin
          .unsafe(
            "CREATE FUNCTION farm.pause_acceptance_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1870014,99); RETURN NEW; END; $$; CREATE TRIGGER pause_acceptance_fixture BEFORE UPDATE ON farm.connector_credential_proofs FOR EACH ROW WHEN (NEW.status='consumed') EXECUTE FUNCTION farm.pause_acceptance_fixture();",
          )
          .simple()
      }
      const operation = acceptor().accept(proof)
      try {
        await waiting(
          phase === 'proof-lock' ? 'FOR UPDATE' : "status='consumed'",
        )
        now = pending.expires_at
      } finally {
        if (phase === 'proof-lock') await gate`COMMIT`
        else await gate`SELECT pg_advisory_unlock(1870014,99)`
        gate.release()
      }
      try {
        assert.equal(accepted(await operation), false)
        assert.equal((await slot(deadline.credential.jti))?.status, 'expired')
        now -= 1000
        assert.equal((await acceptor().issue(deadline.request)).ok, false)
        now += 1000
      } finally {
        if (phase === 'proof-write')
          await admin
            .unsafe(
              'DROP TRIGGER pause_acceptance_fixture ON farm.connector_credential_proofs; DROP FUNCTION farm.pause_acceptance_fixture();',
            )
            .simple()
      }
    }
    checks.push(
      'proof-expiry-after-row-lock-and-consumption-write-waits-rolls-back-success-and-retains-watermark',
    )

    const capped = await issued()
    const admissionGate = await admin.reserve()
    await admissionGate`SELECT pg_advisory_lock(1870014,n) FROM generate_series(0,31) n`
    try {
      const response = await acceptor().issue(capped.request)
      assert.ok(!response.ok && response.reason === 'busy')
      assert.equal((await slot(capped.credential.jti))?.status, 'idle')
    } finally {
      await admissionGate`SELECT pg_advisory_unlock(1870014,n) FROM generate_series(0,31) n`
      admissionGate.release()
    }
    assert.equal((await acceptor().issue(capped.request)).ok, true)
    checks.push(
      'cluster-wide-fixed-crypto-admission-bound-returns-busy-without-unbounded-challenge-allocation',
    )

    for (const order of ['revoke-first', 'accept-first']) {
      const race = await issued()
      const pending = await challenge(race.request)
      now += 1000
      const proof = signed(race.request, pending)
      const gate = await admin.reserve()
      await gate`SELECT pg_advisory_lock(1870014,99)`
      const table =
        order === 'revoke-first'
          ? 'connector_revocations'
          : 'connector_credential_proofs'
      await admin
        .unsafe(
          `CREATE FUNCTION farm.pause_acceptance_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1870014,99); RETURN NEW; END; $$; CREATE TRIGGER pause_acceptance_fixture BEFORE ${order === 'revoke-first' ? 'INSERT' : 'UPDATE'} ON farm.${table} FOR EACH ROW ${order === 'accept-first' ? "WHEN (NEW.status='consumed')" : ''} EXECUTE FUNCTION farm.pause_acceptance_fixture();`,
        )
        .simple()
      const revokeRequest = {
        ...race.subject,
        agentId: race.agentId,
        expectedFingerprint: race.expectedFingerprint,
      }
      let acceptPromise: ReturnType<ReturnType<typeof acceptor>['accept']>,
        revokePromise: ReturnType<typeof revoke.revoke>
      try {
        if (order === 'revoke-first') {
          revokePromise = revoke.revoke(revokeRequest)
          await waiting('INSERT INTO farm.connector_revocations', revokerRole)
          acceptPromise = acceptor().accept(proof)
          await waiting('FROM farm.connector_enrollments')
        } else {
          acceptPromise = acceptor().accept(proof)
          await waiting("status='consumed'")
          revokePromise = revoke.revoke(revokeRequest)
          await waiting('FROM farm.connector_enrollments', revokerRole)
        }
      } finally {
        await gate`SELECT pg_advisory_unlock(1870014,99)`
        gate.release()
      }
      try {
        assert.equal((await revokePromise).ok, true)
        assert.equal(accepted(await acceptPromise), order === 'accept-first')
        now += 1000
        assert.equal((await acceptor().issue(race.request)).ok, false)
      } finally {
        await admin
          .unsafe(
            `DROP TRIGGER pause_acceptance_fixture ON farm.${table}; DROP FUNCTION farm.pause_acceptance_fixture();`,
          )
          .simple()
      }
    }
    checks.push(
      'both-revocation-acceptance-race-orders-linearize-at-enrollment-no-continued-authority-after-revocation',
    )

    {
      const boundary = await issued()
      const pending = await challenge(boundary.request)
      now += 1000
      assert.equal(
        accepted(await acceptor().accept(signed(boundary.request, pending))),
        true,
      )
      const expiry = boundary.credential.expires_at * 1000
      let reads = 0
      const regressing = new PostgresConnectorCredentialAcceptance(
        sql,
        acceptanceConfig,
        () => (++reads === 1 ? expiry : expiry - 2000),
      )
      assert.deepEqual(await regressing.issue(boundary.request), {
        ok: false,
        reason: 'denied',
      })
      const retained = await slot(boundary.credential.jti)
      assert.equal(Number(retained?.observed_at), expiry)
      assert.equal(Number(retained?.credential_expired_at), expiry)
      now = expiry - 2000
      assert.deepEqual(await acceptor().issue(boundary.request), {
        ok: false,
        reason: 'denied',
      })
      now = expiry
    }
    checks.push(
      'existing-slot-retains-pre-lock-expiry-despite-post-lock-clock-regression',
    )

    for (const phase of [
      'after-jose',
      'after-ed25519',
      'after-write',
      'after-commit',
    ]) {
      const boundary = await issued()
      const pending = await challenge(boundary.request)
      now += 1000
      const proof = signed(boundary.request, pending)
      const normal = now,
        expiry = boundary.credential.expires_at * 1000
      let reads = 0
      const threshold =
        phase === 'after-jose'
          ? 3
          : phase === 'after-ed25519'
            ? 4
            : phase === 'after-write'
              ? 5
              : 6
      const stepped = new PostgresConnectorCredentialAcceptance(
        sql,
        acceptanceConfig,
        () => (++reads >= threshold ? expiry : normal),
      )
      assert.equal(accepted(await stepped.accept(proof)), false)
      assert.notEqual(
        (await slot(boundary.credential.jti))?.credential_expired_at,
        null,
      )
      now = normal
      assert.equal((await acceptor().issue(boundary.request)).ok, false)
      now = expiry
    }
    checks.push(
      'token-deadline-after-jose-ed25519-write-and-commit-denies-and-retains-expiry-across-clock-regression',
    )

    for (const table of [
      'connector_enrollments',
      'connector_credentials',
      'connector_revocations',
      'telemetry_events',
    ]) {
      assert.equal(
        (
          await sql`SELECT has_table_privilege(current_user,${'farm.' + table},'INSERT') AS allowed`
        )[0]?.allowed,
        false,
      )
    }
    for (const query of [
      'DELETE FROM farm.connector_credential_proofs',
      'TRUNCATE farm.connector_credential_proofs',
      "UPDATE farm.connector_enrollments SET status='approved'",
      'UPDATE farm.connector_credentials SET jti=jti',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.connector_credential_proofs SET observed_at=observed_at-1`,
    )
    await assert.rejects(
      admin`UPDATE farm.connector_credential_proofs SET generation=0`,
    )
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.connector_credential_proofs WHERE jti=${attempts.credential.jti}::uuid`
      )[0]?.n,
      1,
    )
    checks.push(
      'least-privileged-acceptor-no-enrollment-revocation-credential-telemetry-write-immutable-monotonic-bounded-proof-slots',
    )
    if (restartFixturePath) {
      const live = await issued()
      const liveChallenge = await challenge(live.request)
      const pendingProof = signed(live.request, liveChallenge)
      const replay = await issued()
      const replayChallenge = await challenge(replay.request)
      const replayProof = signed(replay.request, replayChallenge)
      now += 1000
      assert.equal(accepted(await acceptor().accept(replayProof)), true)
      const databaseStarted = (
        await admin`SELECT pg_postmaster_start_time()::text AS started`
      )[0]?.started
      await writeFile(
        restartFixturePath,
        JSON.stringify({
          pendingProof,
          replayProof,
          now: now + 1000,
          publicKeySpki: Buffer.from(
            await crypto.subtle.exportKey('spki', keys.publicKey),
          ).toString('base64url'),
          config: {
            issuer: issuer.issuer,
            audience: issuer.audience,
            origin: config.origin,
            purpose: acceptanceConfig.purpose,
            kid: issuer.kid,
            ttlSeconds: issuer.ttlSeconds,
            proofTtlMs: acceptanceConfig.proofTtlMs,
          },
          seedPid: process.pid,
          databaseStarted,
        }),
        { flag: 'wx', mode: 0o600 },
      )
    }
  } finally {
    await Promise.all([
      sql.end({ timeout: 3 }),
      claimSql.end({ timeout: 3 }),
      revocationSql.end({ timeout: 3 }),
    ])
    for (const user of [role, claimRole, revokerRole])
      await admin`DROP ROLE ${admin(user)}`
  }
  return checks
}
