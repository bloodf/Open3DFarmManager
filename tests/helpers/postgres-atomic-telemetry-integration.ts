import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import {
  PostgresConnectorCredentialAcceptance,
  type TelemetryCommitDecision,
} from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import { type TelemetryProofChallenge } from '../../packages/farm-protocol/src/telemetry-proof.ts'

/** Caller-owned disposable synthetic fixture, official journal through0016. No hardware or token logs. */
export async function testPostgresAtomicTelemetry(
  admin: Sql,
  port: number,
  restartFixturePath?: string,
): Promise<string[]> {
  const prefix = 'telemetry_fixture_' + randomUUID().replaceAll('-', '')
  const roles = [
    { name: prefix, group: 'farm_connector_telemetry_writer' },
    { name: prefix + '_claim', group: 'farm_pairing_runtime' },
    { name: prefix + '_revoke', group: 'farm_connector_revoker' },
    { name: prefix + '_owner', group: 'farm_printer_ownership' },
    { name: prefix + '_generic', group: 'farm_connector_credential_acceptor' },
  ]
  for (const role of roles)
    await admin`CREATE ROLE ${admin(role.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(role.group)}`
  const connect = (user: string) =>
    postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: user,
      max: 5,
      connect_timeout: 3,
      connection: { application_name: user },
    })
  const sql = connect(prefix),
    claimSql = connect(prefix + '_claim'),
    revocationSql = connect(prefix + '_revoke'),
    ownershipSql = connect(prefix + '_owner'),
    genericSql = connect(prefix + '_generic')
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
    purpose: 'telemetry-ingestion',
    publicKeys: new Map([[issuer.kid, keys.publicKey]]),
    ttlSeconds: issuer.ttlSeconds,
    proofTtlMs: 30000,
  } satisfies ConstructorParameters<
    typeof PostgresConnectorCredentialAcceptance
  >[1]
  const service = () =>
    new PostgresConnectorCredentialAcceptance(sql, acceptanceConfig, () => now)
  const generic = () =>
    new PostgresConnectorCredentialAcceptance(
      genericSql,
      acceptanceConfig,
      () => now,
    )
  const ownership = new PostgresPrinterOwnership(ownershipSql, () => now)
  async function issued(subject?: Awaited<ReturnType<typeof actor>>) {
    const item = await prepare(subject)
    const claim = await pairing.claim(item.device, issuer)
    if (!claim.ok || claim.status !== 'approved')
      throw new Error('Fixture claim failed')
    const request = {
      token: claim.device_token,
      agentId: item.agentId,
      farmId: item.farmId,
      connectionId: randomUUID(),
    }
    const credential = (
      await admin`SELECT jti,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=${item.agentId}::uuid`
    )[0]
    if (!credential) throw new Error('Fixture credential missing')
    return { ...item, request, credential }
  }
  function event(printerKey: string, eventId = randomUUID()) {
    return {
      eventId,
      queuedAt: now,
      kind: 'printer-state',
      state: { printerKey, state: 'idle', progress: 0, observedAt: now },
    }
  }
  const bytes = (events: ReturnType<typeof event>[]) =>
    Buffer.from(JSON.stringify(events))
  const ownRequest = (
    item: Awaited<ReturnType<typeof issued>>,
    printerKey: string,
  ) => ({ ...item.subject, agentId: item.agentId, printerKey })
  async function assigned(printerKey = 'printer-a') {
    const item = await issued()
    const assignment = await ownership.register(ownRequest(item, printerKey))
    assert.equal(assignment.ok, true)
    if (!assignment.ok) throw new Error('Missing assignment')
    return { ...item, printerKey, assignmentId: assignment.assignmentId }
  }
  async function challenge(
    item: Awaited<ReturnType<typeof issued>>,
    body: Uint8Array,
  ) {
    const result = await service().issueTelemetryChallenge(item.request, body)
    if (!result.ok || result.kind !== 'challenge')
      throw new Error('Fixture telemetry challenge failed')
    return result.challenge
  }
  function signed(
    item: Awaited<ReturnType<typeof issued>>,
    body: Uint8Array,
    challenge: TelemetryProofChallenge,
  ) {
    return {
      ...item.request,
      challenge,
      signature: identity.signTelemetryProof({
        challenge,
        token: item.request.token,
        body,
        expectedOrigin: config.origin,
        expectedAudience: issuer.audience,
        expectedConnectionId: item.request.connectionId,
        now,
      }),
    }
  }
  const committed = (result: TelemetryCommitDecision) =>
    result.ok && result.kind === 'telemetry-committed'
  const count = async (item: { agentId: string; farmId: string }) =>
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE farm_id=${item.farmId}::uuid AND agent_id=${item.agentId}::uuid`
      )[0]?.n,
    )
  const slot = async (jti: string) =>
    (
      await admin`SELECT generation::float8,observed_at::float8,status,proof_version,operation_method,operation_path,body_sha256,body_bytes,credential_expired_at::float8 FROM farm.connector_credential_proofs WHERE jti=${jti}::uuid`
    )[0]
  async function waiting(fragment: string, application = prefix, count = 1) {
    const end = performance.now() + 750
    while (true) {
      if (
        (
          await admin`SELECT 1 FROM pg_stat_activity WHERE application_name=${application} AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
        ).length >= count
      )
        return
      assert.ok(
        performance.now() < end,
        'Expected fixture lock wait ' + fragment,
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    const actual = await assigned()
    const records = [event(actual.printerKey), event(actual.printerKey)],
      body = bytes(records)
    const pending = await challenge(actual, body)
    const proof = signed(actual, body, pending)
    now += 1000
    const gate = await admin.reserve()
    await gate`BEGIN`
    await gate`SELECT jti FROM farm.connector_credential_proofs WHERE jti=${actual.credential.jti}::uuid FOR UPDATE`
    const contenders = [
      service().commitTelemetryWithProof(proof, body),
      service().commitTelemetryWithProof(proof, body),
    ]
    try {
      await waiting('FROM farm.connector_credential_proofs', prefix, 2)
    } finally {
      await gate`ROLLBACK`
      gate.release()
    }
    const result = await Promise.all(contenders)
    assert.equal(result.filter(committed).length, 1)
    assert.deepEqual(
      result.find((decision) => !decision.ok),
      {
        ok: false,
        reason: 'busy',
        retryAfterMs: 1000,
      },
    )
    const success = result.find(committed)
    assert.ok(success?.ok && success.kind === 'telemetry-committed')
    assert.deepEqual(
      success.acceptedEventIds,
      records.map((record) => record.eventId),
    )
    assert.equal(await count(actual), 2)
    assert.equal((await slot(actual.credential.jti))?.status, 'consumed')
    now += 1000
    assert.deepEqual(await service().commitTelemetryWithProof(proof, body), {
      ok: false,
      reason: 'denied',
    })
    now += 1000
    const fresh = await challenge(actual, body)
    assert.equal(fresh.generation, pending.generation + 1)
    now += 1000
    assert.equal(
      committed(
        await service().commitTelemetryWithProof(
          signed(actual, body, fresh),
          body,
        ),
      ),
      true,
    )
    assert.equal(await count(actual), 2)
    now += 1000
    assert.equal(
      (await service().commitTelemetryWithProof(proof, body)).ok,
      false,
    )
    checks.push(
      'actual-jose-live-connector-v2-proof-atomic-batch-single-winner-and-fresh-proof-idempotent-dedup',
    )

    const boundary = await assigned()
    const raw = bytes([event(boundary.printerKey)])
    const v1 = await generic().issue(boundary.request)
    if (!v1.ok || v1.kind !== 'challenge')
      throw new Error('Fixture generic challenge failed')
    const genericProof = {
      ...boundary.request,
      challenge: v1.challenge,
      signature: identity.signCredentialProof({
        challenge: v1.challenge,
        token: boundary.request.token,
        expectedOrigin: config.origin,
        expectedAudience: issuer.audience,
        expectedPurpose: acceptanceConfig.purpose,
        expectedConnectionId: boundary.request.connectionId,
        now,
      }),
    }
    assert.deepEqual(
      await service().commitTelemetryWithProof(genericProof, raw),
      { ok: false, reason: 'invalid-input' },
    )
    now += 1000
    assert.equal((await generic().accept(genericProof)).ok, true)
    now += 1000
    const v2 = await challenge(boundary, raw)
    const { method, path, body_sha256, body_bytes, ...base } = v2
    const fabricated = { ...base, v: 1 }
    const fabricatedProof = {
      ...boundary.request,
      challenge: fabricated,
      signature: identity.signCredentialProof({
        challenge: fabricated,
        token: boundary.request.token,
        expectedOrigin: config.origin,
        expectedAudience: issuer.audience,
        expectedPurpose: acceptanceConfig.purpose,
        expectedConnectionId: boundary.request.connectionId,
        now,
      }),
    }
    now += 1000
    assert.deepEqual(await generic().accept(fabricatedProof), {
      ok: false,
      reason: 'denied',
    })
    assert.equal((await slot(boundary.credential.jti))?.status, 'pending')
    now += 1000
    assert.equal(
      committed(
        await service().commitTelemetryWithProof(
          signed(boundary, raw, v2),
          raw,
        ),
      ),
      true,
    )
    now += 1000
    const reset = await generic().issue(boundary.request)
    assert.ok(reset.ok && reset.kind === 'challenge' && reset.challenge.v === 1)
    const resetSlot = await slot(boundary.credential.jti)
    assert.equal(resetSlot?.proof_version, 1)
    for (const column of [
      'operation_method',
      'operation_path',
      'body_sha256',
      'body_bytes',
    ])
      assert.equal(resetSlot?.[column], null)
    checks.push(
      'generic-v1-signatures-receipts-cannot-consume-operation-v2-or-authorize-writes-legitimate-replacement-resets-binding',
    )

    const changed = await assigned()
    const unchanged = bytes([event(changed.printerKey)]),
      c = await challenge(changed, unchanged),
      valid = signed(changed, unchanged, c)
    now += 1000
    assert.deepEqual(
      await service().commitTelemetryWithProof(
        valid,
        Buffer.concat([unchanged, Buffer.from(' ')]),
      ),
      { ok: false, reason: 'denied' },
    )
    assert.equal((await slot(changed.credential.jti))?.status, 'pending')
    for (const patch of [
      { method: 'GET' },
      { path: '/api/other' },
      { purpose: 'signalling' },
      { v: 1 },
    ])
      assert.deepEqual(
        await service().commitTelemetryWithProof(
          { ...valid, challenge: { ...c, ...patch } },
          unchanged,
        ),
        { ok: false, reason: 'invalid-input' },
      )
    now += 1000
    assert.equal(
      committed(await service().commitTelemetryWithProof(valid, unchanged)),
      true,
    )
    const unowned = await issued()
    const forbidden = bytes([event('not-assigned')]),
      forbiddenChallenge = await challenge(unowned, forbidden)
    now += 1000
    assert.deepEqual(
      await service().commitTelemetryWithProof(
        signed(unowned, forbidden, forbiddenChallenge),
        forbidden,
      ),
      { ok: false, reason: 'forbidden-printer' },
    )
    assert.equal(await count(unowned), 0)
    assert.equal((await slot(unowned.credential.jti))?.status, 'pending')
    const otherAgent = await issued(unowned.subject)
    assert.equal(
      (
        await ownership.register(
          ownRequest(otherAgent, 'foreign-agent-printer'),
        )
      ).ok,
      true,
    )
    const foreignBody = bytes([event('foreign-agent-printer')])
    now += 1000
    // Existing pending unknown-printer operation must expire before this distinct body replaces it.
    now = forbiddenChallenge.expires_at
    const foreignChallenge = await challenge(unowned, foreignBody)
    now += 1000
    assert.deepEqual(
      await service().commitTelemetryWithProof(
        signed(unowned, foreignBody, foreignChallenge),
        foreignBody,
      ),
      { ok: false, reason: 'forbidden-printer' },
    )
    assert.equal(await count(unowned), 0)
    checks.push(
      'exact-byte-method-path-purpose-version-and-authoritative-printer-checks-deny-without-writing-or-consuming-unrelated-proof',
    )

    const conflict = await assigned()
    const old = event(
        conflict.printerKey,
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ),
      newRecord = event(
        conflict.printerKey,
        '00000000-0000-4000-8000-000000000001',
      )
    await admin`INSERT INTO farm.telemetry_events (farm_id,agent_id,event_id,payload) VALUES (${conflict.farmId}::uuid,${conflict.agentId}::uuid,${old.eventId}::uuid,${admin.json(old)}::jsonb)`
    const conflicting = bytes([
        newRecord,
        { ...old, state: { ...old.state, progress: 0.5 } },
      ]),
      conflictChallenge = await challenge(conflict, conflicting)
    now += 1000
    assert.deepEqual(
      await service().commitTelemetryWithProof(
        signed(conflict, conflicting, conflictChallenge),
        conflicting,
      ),
      { ok: false, reason: 'conflict' },
    )
    assert.equal(await count(conflict), 1)
    assert.equal(
      (
        await admin`SELECT 1 FROM farm.telemetry_events WHERE farm_id=${conflict.farmId}::uuid AND agent_id=${conflict.agentId}::uuid AND event_id=${newRecord.eventId}::uuid`
      ).length,
      0,
    )
    assert.equal((await slot(conflict.credential.jti))?.status, 'pending')
    checks.push(
      'conflicting-reused-id-rolls-back-entire-batch-and-proof-consumption-after-earlier-insert',
    )
    for (const mutation of ['connector', 'ownership'])
      for (const order of ['mutation-first', 'ingest-first']) {
        const race = await assigned()
        const body = bytes([event(race.printerKey)]),
          pending = await challenge(race, body)
        now += 1000
        const proof = signed(race, body, pending)
        const mutationAction = () =>
          mutation === 'connector'
            ? revoke.revoke({
                ...race.subject,
                agentId: race.agentId,
                expectedFingerprint: race.expectedFingerprint,
              })
            : ownership.revoke({
                ...ownRequest(race, race.printerKey),
                expectedAssignmentId: race.assignmentId,
              })
        const table =
          order === 'ingest-first'
            ? 'telemetry_events'
            : mutation === 'connector'
              ? 'connector_revocations'
              : 'printer_assignments'
        const triggerEvent =
          table === 'printer_assignments' ? 'UPDATE' : 'INSERT'
        const gate = await admin.reserve()
        await gate`SELECT pg_advisory_lock(1870016,7)`
        await admin
          .unsafe(
            `CREATE FUNCTION farm.pause_telemetry_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1870016,7); RETURN NEW; END; $$; CREATE TRIGGER pause_telemetry_fixture BEFORE ${triggerEvent} ON farm.${table} FOR EACH ROW EXECUTE FUNCTION farm.pause_telemetry_fixture();`,
          )
          .simple()
        let ingest: Promise<TelemetryCommitDecision>,
          mutate: ReturnType<typeof mutationAction>
        try {
          if (order === 'mutation-first') {
            mutate = mutationAction()
            await waiting(
              table === 'printer_assignments'
                ? 'UPDATE farm.printer_assignments'
                : 'INSERT INTO farm.connector_revocations',
              prefix + (mutation === 'connector' ? '_revoke' : '_owner'),
            )
            ingest = service().commitTelemetryWithProof(proof, body)
            await waiting('FROM farm.connector_enrollments')
          } else {
            ingest = service().commitTelemetryWithProof(proof, body)
            await waiting('INSERT INTO farm.telemetry_events')
            mutate = mutationAction()
            await waiting(
              'FROM farm.connector_enrollments',
              prefix + (mutation === 'connector' ? '_revoke' : '_owner'),
            )
          }
        } finally {
          await gate`SELECT pg_advisory_unlock(1870016,7)`
          gate.release()
        }
        try {
          assert.equal((await mutate).ok, true)
          const result = await ingest
          if (order === 'ingest-first') assert.equal(committed(result), true)
          else
            assert.deepEqual(result, {
              ok: false,
              reason: mutation === 'connector' ? 'denied' : 'forbidden-printer',
            })
          assert.equal(await count(race), order === 'ingest-first' ? 1 : 0)
          now += 1000
          if (mutation === 'connector')
            assert.deepEqual(
              await service().issueTelemetryChallenge(race.request, body),
              { ok: false, reason: 'denied' },
            )
          else {
            const next = await challenge(race, body)
            now += 1000
            assert.deepEqual(
              await service().commitTelemetryWithProof(
                signed(race, body, next),
                body,
              ),
              { ok: false, reason: 'forbidden-printer' },
            )
          }
        } finally {
          await admin
            .unsafe(
              `DROP TRIGGER pause_telemetry_fixture ON farm.${table}; DROP FUNCTION farm.pause_telemetry_fixture();`,
            )
            .simple()
        }
      }
    checks.push(
      'both-connector-revocation-and-printer-ownership-race-orders-serialize-with-atomic-ingestion',
    )

    for (const phase of ['ownership-wait', 'event-unique-wait']) {
      const deadline = await assigned()
      const records = [
          event(deadline.printerKey, '00000000-0000-4000-8000-000000000001'),
          event(deadline.printerKey, 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
        ],
        body = bytes(records),
        pending = await challenge(deadline, body)
      now += 1000
      const blocked = records[1]
      assert.ok(blocked)
      const proof = signed(deadline, body, pending),
        gate = await admin.reserve()
      await gate`BEGIN`
      if (phase === 'ownership-wait')
        await gate`SELECT id FROM farm.printer_assignments WHERE farm_id=${deadline.farmId}::uuid AND printer_key=${deadline.printerKey} AND revoked_at IS NULL FOR UPDATE`
      else
        await gate`INSERT INTO farm.telemetry_events (farm_id,agent_id,event_id,payload) VALUES (${deadline.farmId}::uuid,${deadline.agentId}::uuid,${blocked.eventId}::uuid,${gate.json(blocked)}::jsonb)`
      const operation = service().commitTelemetryWithProof(proof, body)
      try {
        await waiting(
          phase === 'ownership-wait'
            ? 'FROM farm.printer_assignments'
            : 'INSERT INTO farm.telemetry_events',
        )
        now = pending.expires_at
      } finally {
        await gate`COMMIT`
        gate.release()
      }
      assert.deepEqual(await operation, { ok: false, reason: 'denied' })
      assert.equal(await count(deadline), phase === 'event-unique-wait' ? 1 : 0)
      assert.equal((await slot(deadline.credential.jti))?.status, 'expired')
      now -= 1000
      assert.deepEqual(
        await service().issueTelemetryChallenge(deadline.request, body),
        { ok: false, reason: 'denied' },
      )
      now += 1000
    }
    checks.push(
      'expiry-after-ownership-and-event-uniqueness-waits-rolls-back-proof-and-batch-retains-expiry-watermark',
    )

    const failure = await assigned(),
      failureBody = bytes([event(failure.printerKey)]),
      failureChallenge = await challenge(failure, failureBody)
    now += 1000
    const failureProof = signed(failure, failureBody, failureChallenge)
    await admin
      .unsafe(
        "CREATE FUNCTION farm.fail_telemetry_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic telemetry commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_telemetry_fixture AFTER INSERT ON farm.telemetry_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_telemetry_fixture();",
      )
      .simple()
    try {
      assert.deepEqual(
        await service().commitTelemetryWithProof(failureProof, failureBody),
        { ok: false, reason: 'storage-unavailable' },
      )
      assert.equal(await count(failure), 0)
      assert.equal((await slot(failure.credential.jti))?.status, 'pending')
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_telemetry_fixture ON farm.telemetry_events; DROP FUNCTION farm.fail_telemetry_fixture();',
        )
        .simple()
    }
    assert.equal(
      committed(
        await service().commitTelemetryWithProof(failureProof, failureBody),
      ),
      true,
    )
    checks.push(
      'deferred-commit-failure-rolls-back-proof-and-events-known-rollback-retry-commits-once',
    )

    const uncertain = await assigned(),
      uncertainBody = bytes([event(uncertain.printerKey)]),
      uncertainChallenge = await challenge(uncertain, uncertainBody)
    now += 1000
    const uncertainProof = signed(uncertain, uncertainBody, uncertainChallenge),
      normal = now
    let reads = 0
    const lateCommit = new PostgresConnectorCredentialAcceptance(
      sql,
      acceptanceConfig,
      () => (++reads >= 7 ? uncertainChallenge.expires_at : normal),
    )
    assert.deepEqual(
      await lateCommit.commitTelemetryWithProof(uncertainProof, uncertainBody),
      { ok: false, reason: 'denied' },
    )
    assert.equal(await count(uncertain), 1)
    assert.equal((await slot(uncertain.credential.jti))?.status, 'consumed')
    now = uncertainChallenge.expires_at + 1000
    const retry = await challenge(uncertain, uncertainBody)
    now += 1000
    const retryResult = await service().commitTelemetryWithProof(
      signed(uncertain, uncertainBody, retry),
      uncertainBody,
    )
    assert.ok(retryResult.ok && retryResult.kind === 'telemetry-committed')
    assert.equal(await count(uncertain), 1)
    checks.push(
      'post-commit-expired-response-returns-no-ack-fresh-proof-identical-batch-retry-deduplicates',
    )

    assert.equal(
      (
        await genericSql`SELECT has_table_privilege(current_user,'farm.telemetry_events','INSERT') AS allowed`
      )[0]?.allowed,
      false,
    )
    assert.equal(
      (
        await sql`SELECT has_table_privilege(current_user,'farm.printer_assignments','INSERT') AS allowed`
      )[0]?.allowed,
      false,
    )
    await assert.rejects(
      genericSql`UPDATE farm.connector_credential_proofs SET proof_version=2,operation_method='POST',operation_path='/api/connector/telemetry',body_sha256=${randomBytes(32).toString('base64url')},body_bytes=1,generation=generation+1,status='pending',nonce=${randomBytes(32).toString('base64url')},issued_at=${now},expires_at=${now + 1000},observed_at=${now},failures=0,consumed_at=NULL WHERE jti=${actual.credential.jti}::uuid`,
    )
    await assert.rejects(
      sql`UPDATE farm.connector_credential_proofs SET body_bytes=body_bytes+1 WHERE jti=${uncertain.credential.jti}::uuid`,
    )
    await assert.rejects(sql`UPDATE farm.printer_assignments SET id=id`)
    await assert.rejects(
      sql`UPDATE farm.telemetry_events SET event_id=event_id`,
    )
    for (const query of [
      'DELETE FROM farm.telemetry_events',
      'TRUNCATE farm.telemetry_events',
      "UPDATE farm.connector_enrollments SET status='approved'",
      'INSERT INTO farm.connector_revocations (agent_id) VALUES (gen_random_uuid())',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.connector_credential_proofs WHERE jti=${uncertain.credential.jti}::uuid`
      )[0]?.n,
      1,
    )
    checks.push(
      'least-privileged-role-generic-cannot-create-v2-or-write-telemetry-binding-and-assignment-identity-immutable',
    )

    if (restartFixturePath) {
      const lost = await assigned(),
        body = bytes([event(lost.printerKey)]),
        initial = await challenge(lost, body)
      now += 1000
      const consumed = signed(lost, body, initial)
      assert.equal(
        committed(await service().commitTelemetryWithProof(consumed, body)),
        true,
      )
      now += 1000
      const retry = await challenge(lost, body),
        pending = signed(lost, body, retry)
      const started = (
        await admin`SELECT pg_postmaster_start_time()::text AS started`
      )[0]?.started
      await writeFile(
        restartFixturePath,
        JSON.stringify({
          pending,
          consumed,
          body: body.toString('base64url'),
          expectedCount: 1,
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
          databaseStarted: started,
        }),
        { flag: 'wx', mode: 0o600 },
      )
    }
  } finally {
    await Promise.all(
      [sql, claimSql, revocationSql, ownershipSql, genericSql].map((pool) =>
        pool.end({ timeout: 3 }),
      ),
    )
    for (const role of roles) await admin`DROP ROLE ${admin(role.name)}`
  }
  return checks
}
