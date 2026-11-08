import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
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
import {
  connectorKeyBinding,
  issueConnectorCredential,
} from '../../apps/farm/server/utils/connector-credentials.ts'
import { createTelemetryHttpHandler } from '../../apps/farm/server/services/telemetry-http.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { TelemetryProofChallenge } from '../../packages/farm-protocol/src/telemetry-proof.ts'

/** Caller-owned disposable synthetic fixture, official journal through0022. No hardware or token logs. */
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

    // The A2 trigger uses the actual database clock. Construct only this new
    // cohort at wall time; later advance the injected acceptance clock, not SQL.
    now =
      Number(
        (
          await admin`SELECT floor(extract(epoch FROM clock_timestamp()))::float8 AS n`
        )[0]?.n,
      ) * 1000
    const generation = await prepare()
    const binding = await connectorKeyBinding(identity.publicKeySpki)
    const rootJti = randomUUID(),
      successorJti = randomUUID()
    const issuedAt = Math.floor(now / 1000)
    const rootToken = await issueConnectorCredential({
      ...issuer,
      ttlSeconds: 60,
      agentId: generation.agentId,
      farmId: generation.farmId,
      publicKeySpki: identity.publicKeySpki,
      nowSeconds: issuedAt,
      jti: rootJti,
    })
    await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at)
      VALUES(${rootJti}::uuid,${generation.agentId}::uuid,${generation.farmId}::uuid,${binding.fingerprint},${binding.thumbprint},${issuer.kid},${issuer.issuer},${issuer.audience},${issuedAt},${issuedAt + 60})`
    const successorToken = await issueConnectorCredential({
      ...issuer,
      agentId: generation.agentId,
      farmId: generation.farmId,
      publicKeySpki: identity.publicKeySpki,
      nowSeconds: issuedAt,
      jti: successorJti,
    })
    await admin`INSERT INTO farm.connector_credential_successors(jti,root_jti,predecessor_jti,ordinal,kid,issuer,audience,issued_at,expires_at)
      VALUES(${successorJti}::uuid,${rootJti}::uuid,${rootJti}::uuid,1,${issuer.kid},${issuer.issuer},${issuer.audience},${issuedAt},${issuedAt + issuer.ttlSeconds})`
    const successor = {
      ...generation,
      request: {
        token: successorToken,
        agentId: generation.agentId,
        farmId: generation.farmId,
        connectionId: randomUUID(),
      },
      credential: {
        jti: successorJti,
        expires_at: issuedAt + issuer.ttlSeconds,
      },
    }
    assert.equal(
      (await ownership.register(ownRequest(successor, 'successor-printer'))).ok,
      true,
    )
    const successorSlot = async () =>
      (
        await admin`SELECT * FROM farm.connector_successor_proofs WHERE jti=${successorJti}::uuid AND root_jti=${rootJti}::uuid`
      )[0]
    const rootRows = [
      ...(await admin`SELECT * FROM farm.connector_credentials ORDER BY jti`),
    ]
    const rootProofs = [
      ...(await admin`SELECT * FROM farm.connector_credential_proofs ORDER BY jti`),
    ]
    const pauses = [
      ...(await admin`SELECT * FROM farm.pause_authority_challenges ORDER BY challenge_id`),
    ]
    const catalog = await loadMigrationCatalog()
    // Even an empty down cannot destroy downstream dependent objects.
    await admin`CREATE VIEW public.atomic_successor_dependency AS SELECT jti FROM farm.connector_successor_proofs`
    await assert.rejects(
      runMigrations(admin, catalog, {
        kind: 'down',
        expectedLastId: '0022_connector_successor_proofs',
      }),
      { code: '2BP01' },
    )
    await admin`DROP VIEW public.atomic_successor_dependency`
    // Only valid for this fresh fixture before any successor proof exists.
    assert.equal(
      Number(
        (
          await admin`SELECT count(*)::int AS n FROM farm.connector_successor_proofs`
        )[0]?.n,
      ),
      0,
    )
    await runMigrations(admin, catalog, {
      kind: 'down',
      expectedLastId: '0022_connector_successor_proofs',
    })
    await runMigrations(admin, catalog, { kind: 'up' })
    assert.deepEqual(
      [...(await admin`SELECT * FROM farm.connector_credentials ORDER BY jti`)],
      rootRows,
    )
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM farm.connector_credential_proofs ORDER BY jti`),
      ],
      rootProofs,
    )
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM farm.pause_authority_challenges ORDER BY challenge_id`),
      ],
      pauses,
    )
    checks.push(
      'successor-proof-expand-and-empty-down-preserve-root-and-pause-data',
    )

    // Frozen-clock literal legacy slot effects, including a failed candidate
    // preverification. These assertions cover every persisted root-slot field.
    for (const kind of [
      'malformed',
      'unknown-kid',
      'different-jti',
      'bad-successor-signature',
    ]) {
      const legacy = await issued()
      const hintedJti = randomUUID()
      let token = 'malformed'
      if (kind !== 'malformed')
        token = await issueConnectorCredential({
          ...issuer,
          kid: kind === 'unknown-kid' ? 'missing-key' : issuer.kid,
          agentId: legacy.agentId,
          farmId: legacy.farmId,
          publicKeySpki: identity.publicKeySpki,
          nowSeconds: issuedAt,
          jti: kind === 'unknown-kid' ? legacy.credential.jti : hintedJti,
        })
      if (kind === 'bad-successor-signature') {
        await admin`INSERT INTO farm.connector_credential_successors(jti,root_jti,predecessor_jti,ordinal,kid,issuer,audience,issued_at,expires_at)
          VALUES(${hintedJti}::uuid,${legacy.credential.jti}::uuid,${legacy.credential.jti}::uuid,1,${issuer.kid},${issuer.issuer},${issuer.audience},${issuedAt},${issuedAt + issuer.ttlSeconds})`
        const segments = token.split('.'),
          signature = segments[2]
        assert.ok(signature)
        token = [
          segments[0],
          segments[1],
          (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1),
        ].join('.')
      }
      assert.deepEqual(await service().issue({ ...legacy.request, token }), {
        ok: false,
        reason: 'denied',
      })
      const state = (
        await admin`SELECT to_jsonb(p) AS data FROM farm.connector_credential_proofs p WHERE jti=${legacy.credential.jti}::uuid`
      )[0]?.data
      assert.deepEqual(state, {
        jti: legacy.credential.jti,
        observed_at: now,
        next_attempt_at: now + (kind === 'different-jti' ? 1000 : 0),
        credential_expired_at: null,
        generation: 0,
        status: 'idle',
        nonce: null,
        connection_id: null,
        token_hash: null,
        origin: null,
        audience: null,
        purpose: null,
        issued_at: null,
        expires_at: null,
        failures: 0,
        consumed_at: null,
        proof_version: 1,
        operation_method: null,
        operation_path: null,
        body_sha256: null,
        body_bytes: null,
      })
      assert.equal(
        Number(
          (
            await admin`SELECT count(*)::int AS n FROM farm.connector_successor_proofs WHERE root_jti=${legacy.credential.jti}::uuid`
          )[0]?.n,
        ),
        0,
      )
    }
    const legacyRole = await issued()
    const legacyRoleToken = await issueConnectorCredential({
      ...issuer,
      agentId: legacyRole.agentId,
      farmId: legacyRole.farmId,
      publicKeySpki: identity.publicKeySpki,
      nowSeconds: issuedAt,
      jti: randomUUID(),
    })
    assert.deepEqual(
      await generic().issue({ ...legacyRole.request, token: legacyRoleToken }),
      { ok: false, reason: 'denied' },
    )
    assert.equal((await slot(legacyRole.credential.jti))?.generation, 0)
    checks.push(
      'frozen-clock-invalid-root-and-candidate-tokens-retain-all-legacy-slot-fields',
    )

    // Route hints must never create a successor slot without full JWT auth.
    const parts = successorToken.split('.')
    const signature = parts[2]
    assert.ok(signature)
    const invalidSignature = [
      parts[0],
      parts[1],
      (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1),
    ].join('.')
    for (const token of [invalidSignature, 'malformed', rootToken]) {
      assert.equal(
        (await service().issue({ ...successor.request, token })).ok,
        false,
      )
      assert.equal(await successorSlot(), undefined)
    }
    // Root has TTL60 while the telemetry consumer expects TTL300: failed hint
    // authentication must retain the historical no-slot config denial.
    assert.equal(await slot(rootJti), undefined)
    // Different purpose must not even query successor metadata under root-only role.
    const signalling = new PostgresConnectorCredentialAcceptance(
      genericSql,
      { ...acceptanceConfig, purpose: 'signalling' },
      () => now,
    )
    assert.deepEqual(await signalling.issue(successor.request), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(await successorSlot(), undefined)
    checks.push(
      'unverified-successor-hints-cannot-create-slot-signalling-remains-root-only',
    )

    now = (issuedAt + 61) * 1000
    const expiredRootStore = new PostgresConnectorCredentialAcceptance(
      sql,
      { ...acceptanceConfig, ttlSeconds: 60 },
      () => now,
    )
    assert.deepEqual(
      await expiredRootStore.issue({ ...successor.request, token: rootToken }),
      { ok: false, reason: 'denied' },
    )
    const expiredRootSlot = [
      ...(await admin`SELECT * FROM farm.connector_credential_proofs WHERE jti=${rootJti}::uuid`),
    ]
    assert.equal(Number(expiredRootSlot[0]?.credential_expired_at), now)
    // A live successor authenticates even though root time, TTL and expiry differ.
    const genericChallenge = await service().issue(successor.request)
    assert.ok(genericChallenge.ok && genericChallenge.kind === 'challenge')
    assert.equal(genericChallenge.challenge.jti, successorJti)
    const successorGenericProof = {
      ...successor.request,
      challenge: genericChallenge.challenge,
      signature: identity.signCredentialProof({
        challenge: genericChallenge.challenge,
        token: successorToken,
        expectedOrigin: config.origin,
        expectedAudience: issuer.audience,
        expectedPurpose: 'telemetry-ingestion',
        expectedConnectionId: successor.request.connectionId,
        now,
      }),
    }
    now += 1000
    assert.equal((await service().accept(successorGenericProof)).ok, true)
    assert.equal((await successorSlot())?.status, 'consumed')
    now += 1000
    assert.deepEqual(await service().accept(successorGenericProof), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM farm.connector_credential_proofs WHERE jti=${rootJti}::uuid`),
      ],
      expiredRootSlot,
    )
    checks.push(
      'generic-telemetry-successor-proof-with-expired-root-consumes-once',
    )

    async function http(
      item: typeof successor,
      body: Uint8Array,
      proof?: ReturnType<typeof signed>,
      store = service(),
    ) {
      const req = new IncomingMessage(new Socket())
      req.method = 'POST'
      req.url = proof
        ? '/api/connector/telemetry'
        : '/api/connector/telemetry/challenge'
      req.rawHeaders = [
        'authorization',
        'Bearer ' + item.request.token,
        'x-connector-agent',
        item.agentId,
        'x-connector-farm',
        item.farmId,
        'content-type',
        'application/json',
        'content-length',
        String(body.byteLength),
      ]
      if (proof)
        req.rawHeaders.push(
          'x-telemetry-challenge',
          Buffer.from(JSON.stringify(proof.challenge)).toString('base64url'),
          'x-telemetry-signature',
          proof.signature,
        )
      req.push(body)
      req.push(null)
      try {
        return await createTelemetryHttpHandler(
          store,
          1000,
        )({ '~app': { node: { req } } })
      } finally {
        req.destroy()
      }
    }
    const successorBody = bytes([event('successor-printer')])
    now += 1000
    const httpChallenge = await http(successor, successorBody)
    assert.equal(httpChallenge.status, 200)
    assert.ok('challenge' in httpChallenge.body)
    const parsedChallenge = TelemetryProofChallenge.parse(
      httpChallenge.body.challenge,
    )
    const httpItem = {
      ...successor,
      request: {
        ...successor.request,
        connectionId: parsedChallenge.connection_id,
      },
    }
    const httpProof = signed(httpItem, successorBody, parsedChallenge)
    now += 1000
    const response = await http(httpItem, successorBody, httpProof)
    assert.equal(response.status, 200)
    assert.equal(await count(successor), 1)
    assert.equal((await successorSlot())?.status, 'consumed')
    now += 1000
    assert.equal((await http(httpItem, successorBody, httpProof)).status, 403)
    assert.equal(await count(successor), 1)
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM farm.connector_credential_proofs WHERE jti=${rootJti}::uuid`),
      ],
      expiredRootSlot,
    )
    checks.push(
      'real-http-handler-successor-challenge-signature-atomic-commit-and-replay',
    )

    // Existing telemetry savepoint cases also run with the successor identity.
    now += 1000
    const deniedBody = bytes([event('unassigned-successor-printer')])
    const deniedChallenge = await challenge(successor, deniedBody)
    now += 1000
    assert.deepEqual(
      await service().commitTelemetryWithProof(
        signed(successor, deniedBody, deniedChallenge),
        deniedBody,
      ),
      { ok: false, reason: 'forbidden-printer' },
    )
    assert.equal((await successorSlot())?.status, 'pending')
    assert.equal(await count(successor), 1)
    now = deniedChallenge.expires_at
    const conflictedEvents = [event('successor-printer')]
    const conflictedEvent = conflictedEvents[0]
    assert.ok(conflictedEvent)
    await admin`INSERT INTO farm.telemetry_events(farm_id,agent_id,event_id,payload) VALUES(${successor.farmId}::uuid,${successor.agentId}::uuid,${conflictedEvent.eventId}::uuid,${admin.json({ conflict: true })})`
    const conflictBytes = bytes(conflictedEvents),
      successorConflictChallenge = await challenge(successor, conflictBytes)
    now += 1000
    assert.deepEqual(
      await service().commitTelemetryWithProof(
        signed(successor, conflictBytes, successorConflictChallenge),
        conflictBytes,
      ),
      { ok: false, reason: 'conflict' },
    )
    assert.equal((await successorSlot())?.status, 'pending')
    checks.push(
      'successor-savepoint-rolls-back-proof-on-forbidden-printer-and-event-conflict',
    )

    // A later root for another agent may legally share a successor's JTI.
    // Both root and successor writers and late cleanup must remain disjoint.
    const other = await prepare()
    const collisionToken = await issueConnectorCredential({
      ...issuer,
      agentId: other.agentId,
      farmId: other.farmId,
      publicKeySpki: identity.publicKeySpki,
      nowSeconds: Math.floor(now / 1000),
      jti: successorJti,
    })
    await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at)
      VALUES(${successorJti}::uuid,${other.agentId}::uuid,${other.farmId}::uuid,${binding.fingerprint},${binding.thumbprint},${issuer.kid},${issuer.issuer},${issuer.audience},${Math.floor(now / 1000)},${Math.floor(now / 1000) + issuer.ttlSeconds})`
    const collision = {
      ...other,
      request: {
        token: collisionToken,
        agentId: other.agentId,
        farmId: other.farmId,
        connectionId: randomUUID(),
      },
      credential: {
        jti: successorJti,
        expires_at: Math.floor(now / 1000) + issuer.ttlSeconds,
      },
    }
    assert.equal((await service().issue(collision.request)).ok, true)
    const collisionSlot = await slot(successorJti)
    const oldRootSnapshot = [
      ...(await admin`SELECT * FROM farm.connector_credentials WHERE jti=${rootJti}::uuid`),
    ]
    now = successorConflictChallenge.expires_at
    const lateBody = bytes([event('successor-printer')]),
      lateChallenge = await challenge(successor, lateBody)
    now += 1000
    const successorNormal = now,
      selectedSlot = await successorSlot()
    assert.ok(selectedSlot)
    // Successor routing adds two clock reads before the legacy seven reads.
    let clockReads = 0
    const lateSuccessor = new PostgresConnectorCredentialAcceptance(
      sql,
      acceptanceConfig,
      () => (++clockReads >= 9 ? lateChallenge.expires_at : successorNormal),
    )
    assert.deepEqual(
      await lateSuccessor.commitTelemetryWithProof(
        signed(successor, lateBody, lateChallenge),
        lateBody,
      ),
      { ok: false, reason: 'denied' },
    )
    assert.equal(await count(successor), 3)
    assert.equal((await successorSlot())?.status, 'consumed')
    assert.equal((await successorSlot())?.credential_expired_at, null)
    assert.deepEqual(await slot(successorJti), collisionSlot)
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM farm.connector_credentials WHERE jti=${rootJti}::uuid`),
      ],
      oldRootSnapshot,
    )
    checks.push(
      'cross-table-jti-collision-postcommit-cleanup-keeps-root-and-successor-disjoint',
    )

    now = lateChallenge.expires_at + 1000
    const beforeInvalidClaims = await successorSlot()
    for (const changes of [
      { farmId: randomUUID() },
      { kid: 'unknown-successor-key' },
      { nowSeconds: issuedAt + 1 },
      { ttlSeconds: issuer.ttlSeconds - 1 },
    ]) {
      const token = await issueConnectorCredential({
        ...issuer,
        agentId: successor.agentId,
        farmId: successor.farmId,
        publicKeySpki: identity.publicKeySpki,
        nowSeconds: issuedAt,
        jti: successorJti,
        ...changes,
      })
      assert.deepEqual(await service().issue({ ...successor.request, token }), {
        ok: false,
        reason: 'denied',
      })
      assert.deepEqual(await successorSlot(), beforeInvalidClaims)
    }
    for (const changes of [
      { agentId: randomUUID() },
      { farmId: randomUUID() },
    ]) {
      assert.deepEqual(
        await service().issue({ ...successor.request, ...changes }),
        { ok: false, reason: 'denied' },
      )
      assert.deepEqual(await successorSlot(), beforeInvalidClaims)
    }
    let regressedReads = 0
    const regressed = new PostgresConnectorCredentialAcceptance(
      sql,
      acceptanceConfig,
      () => (++regressedReads === 1 ? now : now - 1),
    )
    assert.deepEqual(await regressed.issue(successor.request), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await successorSlot(), {
      ...beforeInvalidClaims,
      observed_at: String(now),
    })
    checks.push(
      'successor-invalid-claims-never-observe-slot-authenticated-clock-regression-denies-authority',
    )

    const successorFailureChallenge = await challenge(successor, lateBody)
    for (let attempt = 0; attempt < 3; attempt++) {
      now += 1000
      assert.deepEqual(
        await service().commitTelemetryWithProof(
          {
            ...signed(successor, lateBody, successorFailureChallenge),
            signature: randomBytes(64).toString('base64url'),
          },
          lateBody,
        ),
        { ok: false, reason: 'denied' },
      )
    }
    assert.equal((await successorSlot())?.status, 'rejected')
    assert.equal((await successorSlot())?.failures, 3)
    now += 1000
    const concurrentChallenge = await challenge(successor, lateBody)
    now += 1000
    const concurrentProof = signed(successor, lateBody, concurrentChallenge)
    const successorGate = await admin.reserve()
    await successorGate`BEGIN`
    await successorGate`SELECT jti FROM farm.connector_successor_proofs WHERE jti=${successorJti}::uuid AND root_jti=${rootJti}::uuid FOR UPDATE`
    const successorContenders = [
      service().commitTelemetryWithProof(concurrentProof, lateBody),
      service().commitTelemetryWithProof(concurrentProof, lateBody),
    ]
    try {
      await waiting('FROM farm.connector_successor_proofs', prefix, 2)
    } finally {
      await successorGate`ROLLBACK`
      successorGate.release()
    }
    const successorDecisions = await Promise.all(successorContenders)
    assert.equal(successorDecisions.filter(committed).length, 1)
    assert.equal(
      successorDecisions.filter((decision) => !decision.ok).length,
      1,
    )
    assert.equal((await successorSlot())?.status, 'consumed')
    assert.equal(await count(successor), 3)
    assert.deepEqual(await slot(successorJti), collisionSlot)
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM farm.connector_credential_proofs WHERE jti=${rootJti}::uuid`),
      ],
      expiredRootSlot,
    )
    checks.push(
      'successor-signature-budget-and-concurrent-consumption-route-only-exact-proof',
    )

    const retainedProof = await successorSlot()
    assert.ok(retainedProof)
    for (const query of [
      sql`UPDATE farm.connector_successor_proofs SET root_jti=${randomUUID()}::uuid WHERE jti=${successorJti}::uuid`,
      sql`UPDATE farm.connector_successor_proofs SET observed_at=0 WHERE jti=${successorJti}::uuid`,
      sql`UPDATE farm.connector_successor_proofs SET generation=9007199254740992 WHERE jti=${successorJti}::uuid`,
      sql`UPDATE farm.connector_successor_proofs SET body_bytes=body_bytes+1 WHERE jti=${successorJti}::uuid`,
      sql`DELETE FROM farm.connector_successor_proofs WHERE jti=${successorJti}::uuid`,
      sql`TRUNCATE farm.connector_successor_proofs`,
      sql`UPDATE farm.connector_credential_successors SET jti=jti WHERE jti=${successorJti}::uuid`,
      genericSql`SELECT * FROM farm.connector_successor_proofs`,
      genericSql`SELECT * FROM farm.connector_credential_successors`,
    ])
      await assert.rejects(query)
    for (const role of [
      'farm_connector_credential_acceptor',
      'farm_signalling_reader',
      'farm_pause_authority',
    ]) {
      assert.equal(
        (
          await admin`SELECT has_table_privilege(${role},'farm.connector_successor_proofs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS allowed`
        )[0]?.allowed,
        false,
      )
      assert.equal(
        (
          await admin`SELECT has_table_privilege(${role},'farm.connector_credential_successors','SELECT,INSERT,UPDATE') AS allowed`
        )[0]?.allowed,
        false,
      )
    }
    await assert.rejects(
      admin`INSERT INTO farm.connector_successor_proofs(jti,root_jti,observed_at,next_attempt_at) VALUES(${successorJti}::uuid,${collision.credential.jti}::uuid,${now},${now})`,
      /exact root binding/,
    )
    const journal = [
      ...(await admin`SELECT * FROM public.open3dfarm_migrations ORDER BY position`),
    ]
    await assert.rejects(
      runMigrations(admin, catalog, {
        kind: 'down',
        expectedLastId: '0022_connector_successor_proofs',
      }),
      /Cannot remove retained successor proofs/,
    )
    assert.deepEqual(
      [
        ...(await admin`SELECT * FROM public.open3dfarm_migrations ORDER BY position`),
      ],
      journal,
    )
    assert.deepEqual(await successorSlot(), retainedProof)
    const reopened = connect(prefix)
    try {
      assert.deepEqual(
        await new PostgresConnectorCredentialAcceptance(
          reopened,
          acceptanceConfig,
          () => now,
        ).accept(successorGenericProof),
        { ok: false, reason: 'denied' },
      )
    } finally {
      await reopened.end({ timeout: 3 })
    }
    assert.equal((await successorSlot())?.status, retainedProof.status)
    checks.push(
      'successor-role-denials-binding-and-watermark-immutability-retained-down-and-reconnect',
    )
    now += 1000
    const revocationBody = bytes([event('successor-printer')])
    const revocationChallenge = await challenge(successor, revocationBody)
    now += 1000
    const revocationGate = await admin.reserve()
    await revocationGate`BEGIN`
    await revocationGate`SELECT jti FROM farm.connector_successor_proofs WHERE jti=${successorJti}::uuid AND root_jti=${rootJti}::uuid FOR UPDATE`
    const finishing = service().commitTelemetryWithProof(
      signed(successor, revocationBody, revocationChallenge),
      revocationBody,
    )
    let revoking: ReturnType<typeof revoke.revoke> | undefined
    try {
      await waiting('FROM farm.connector_successor_proofs')
      revoking = revoke.revoke({
        ...generation.subject,
        agentId: generation.agentId,
        farmId: generation.farmId,
        expectedFingerprint: identity.fingerprint,
      })
      await waiting('FROM farm.connector_enrollments', prefix + '_revoke')
    } finally {
      await revocationGate`ROLLBACK`
      revocationGate.release()
    }
    assert.equal(committed(await finishing), true)
    assert.ok(revoking)
    const revokedGeneration = await revoking
    assert.equal(revokedGeneration.ok, true)
    const beforeRevoked = await successorSlot()
    assert.deepEqual(await service().issue(successor.request), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await successorSlot(), beforeRevoked)
    checks.push(
      'concurrent-revocation-waits-for-successor-acceptance-and-root-tombstone-denies-later-use',
    )

    // Regression: authentic expiry must become terminal before any fallback.
    // Use independent credentials for v1/v2 so one terminal marker cannot hide
    // a failure in the other path. No real clock waiting or process is needed.
    for (const version of ['v1', 'v2']) {
      const epoch = Number(
        (
          await admin`SELECT floor(extract(epoch FROM clock_timestamp()))::float8 AS n`
        )[0]?.n,
      )
      now = epoch * 1000
      const cohort = await prepare(),
        anchorJti = randomUUID(),
        exactJti = randomUUID()
      await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at)
        VALUES(${anchorJti}::uuid,${cohort.agentId}::uuid,${cohort.farmId}::uuid,${binding.fingerprint},${binding.thumbprint},${issuer.kid},${issuer.issuer},${issuer.audience},${epoch},${epoch + 60})`
      const token = await issueConnectorCredential({
        ...issuer,
        agentId: cohort.agentId,
        farmId: cohort.farmId,
        publicKeySpki: identity.publicKeySpki,
        nowSeconds: epoch,
        jti: exactJti,
      })
      await admin`INSERT INTO farm.connector_credential_successors(jti,root_jti,predecessor_jti,ordinal,kid,issuer,audience,issued_at,expires_at)
        VALUES(${exactJti}::uuid,${anchorJti}::uuid,${anchorJti}::uuid,1,${issuer.kid},${issuer.issuer},${issuer.audience},${epoch},${epoch + issuer.ttlSeconds})`
      const item = {
        ...cohort,
        request: {
          token,
          agentId: cohort.agentId,
          farmId: cohort.farmId,
          connectionId: randomUUID(),
        },
        credential: { jti: exactJti, expires_at: epoch + issuer.ttlSeconds },
      }
      assert.equal(
        (await ownership.register(ownRequest(item, 'expiry-regression'))).ok,
        true,
      )
      const sibling = await prepare()
      const siblingToken = await issueConnectorCredential({
        ...issuer,
        agentId: sibling.agentId,
        farmId: sibling.farmId,
        publicKeySpki: identity.publicKeySpki,
        nowSeconds: epoch,
        jti: exactJti,
      })
      await admin`INSERT INTO farm.connector_credentials(jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at,expires_at)
        VALUES(${exactJti}::uuid,${sibling.agentId}::uuid,${sibling.farmId}::uuid,${binding.fingerprint},${binding.thumbprint},${issuer.kid},${issuer.issuer},${issuer.audience},${epoch},${epoch + issuer.ttlSeconds})`
      const expires = (epoch + issuer.ttlSeconds) * 1000
      now = expires - 10000
      assert.equal(
        (
          await service().issue({
            token: siblingToken,
            agentId: sibling.agentId,
            farmId: sibling.farmId,
            connectionId: randomUUID(),
          })
        ).ok,
        true,
      )
      const rootSnapshot = [
        ...(await admin`SELECT * FROM farm.connector_credentials WHERE jti IN (${anchorJti}::uuid,${exactJti}::uuid) ORDER BY jti`),
      ]
      const rootSlotSnapshot = [
        ...(await admin`SELECT * FROM farm.connector_credential_proofs WHERE jti IN (${anchorJti}::uuid,${exactJti}::uuid) ORDER BY jti`),
      ]
      const exactSlot = async () =>
        (
          await admin`SELECT * FROM farm.connector_successor_proofs WHERE jti=${exactJti}::uuid AND root_jti=${anchorJti}::uuid`
        )[0]
      const expiryBody = bytes([event('expiry-regression')])
      let completeOriginal: (
        store: PostgresConnectorCredentialAcceptance,
      ) => Promise<void>
      if (version === 'v1') {
        const issued = await service().issue(item.request)
        assert.ok(issued.ok && issued.kind === 'challenge')
        assert.equal(issued.challenge.expires_at, expires)
        const original = {
          ...item.request,
          challenge: issued.challenge,
          signature: identity.signCredentialProof({
            challenge: issued.challenge,
            token,
            expectedOrigin: config.origin,
            expectedAudience: issuer.audience,
            expectedPurpose: 'telemetry-ingestion',
            expectedConnectionId: item.request.connectionId,
            now,
          }),
        }
        completeOriginal = async (store) => {
          assert.deepEqual(await store.accept(original), {
            ok: false,
            reason: 'denied',
          })
        }
      } else {
        const issued = await http(item, expiryBody)
        assert.equal(issued.status, 200)
        assert.ok('challenge' in issued.body)
        const challenge = TelemetryProofChallenge.parse(issued.body.challenge)
        assert.equal(challenge.expires_at, expires)
        const originalItem = {
          ...item,
          request: { ...item.request, connectionId: challenge.connection_id },
        }
        const original = signed(originalItem, expiryBody, challenge)
        completeOriginal = async (store) => {
          assert.equal(
            (await http(originalItem, expiryBody, original, store)).status,
            403,
          )
        }
      }
      const pendingSlot = await exactSlot()
      assert.ok(pendingSlot)
      assert.equal(pendingSlot.status, 'pending')
      assert.equal(pendingSlot.credential_expired_at, null)
      // Neither a forged signature nor signed metadata mismatch may observe
      // this successor, even at the apparent credential expiry.
      now = expires
      const segments = token.split('.'),
        signature = segments[2]
      assert.ok(signature)
      const badSignature = [
        segments[0],
        segments[1],
        (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1),
      ].join('.')
      const badMetadata = await issueConnectorCredential({
        ...issuer,
        ttlSeconds: issuer.ttlSeconds - 1,
        agentId: item.agentId,
        farmId: item.farmId,
        publicKeySpki: identity.publicKeySpki,
        nowSeconds: epoch,
        jti: exactJti,
      })
      for (const invalidToken of [badSignature, badMetadata]) {
        assert.deepEqual(
          await service().issue({ ...item.request, token: invalidToken }),
          { ok: false, reason: 'denied' },
        )
        assert.deepEqual(await exactSlot(), pendingSlot)
      }
      // v1 also regresses while async identity authentication is in flight:
      // the real pre-verification E sample must still be persisted, not lost.
      let samples = 0
      const expiredEntry = new PostgresConnectorCredentialAcceptance(
        sql,
        acceptanceConfig,
        () => (version === 'v1' && ++samples > 1 ? expires - 5000 : expires),
      )
      if (version === 'v1')
        assert.deepEqual(await expiredEntry.issue(item.request), {
          ok: false,
          reason: 'denied',
        })
      else
        assert.equal(
          (await http(item, expiryBody, undefined, expiredEntry)).status,
          403,
        )
      const terminal = await exactSlot()
      assert.ok(terminal)
      assert.deepEqual(
        {
          observed: Number(terminal.observed_at),
          marker: Number(terminal.credential_expired_at),
          status: terminal.status,
          consumed: Number(terminal.consumed_at),
        },
        {
          observed: expires,
          marker: expires,
          status: 'expired',
          consumed: expires,
        },
      )
      now = expires - 5000
      assert.ok(now > Number(pendingSlot.observed_at))
      assert.ok(
        now > Number(pendingSlot.next_attempt_at),
        'Throttle must not mask the regression',
      )
      const restartedPool = connect(prefix)
      try {
        const restarted = new PostgresConnectorCredentialAcceptance(
          restartedPool,
          acceptanceConfig,
          () => now,
        )
        if (version === 'v1')
          assert.deepEqual(await restarted.issue(item.request), {
            ok: false,
            reason: 'denied',
          })
        else
          assert.equal(
            (await http(item, expiryBody, undefined, restarted)).status,
            403,
          )
        await completeOriginal(restarted)
      } finally {
        await restartedPool.end({ timeout: 3 })
      }
      assert.deepEqual(await exactSlot(), terminal)
      assert.equal(await count(item), 0)
      assert.deepEqual(
        [
          ...(await admin`SELECT * FROM farm.connector_credentials WHERE jti IN (${anchorJti}::uuid,${exactJti}::uuid) ORDER BY jti`),
        ],
        rootSnapshot,
      )
      assert.deepEqual(
        [
          ...(await admin`SELECT * FROM farm.connector_credential_proofs WHERE jti IN (${anchorJti}::uuid,${exactJti}::uuid) ORDER BY jti`),
        ],
        rootSlotSnapshot,
      )
      checks.push(
        'authenticated-successor-' +
          version +
          '-expiry-entry-is-terminal-after-repository-restart-and-clock-regression',
      )
    }

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
