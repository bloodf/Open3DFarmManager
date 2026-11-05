import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  connectorKeyBinding,
  verifyConnectorCredential,
} from '../../apps/farm/server/utils/connector-credentials.ts'

/** Caller-owned disposable loopback fixture with officially applied migrations 0001–0010. Tokens are never printed. */
export async function testPostgresCredentialIssuance(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const role = 'credential_fixture_' + randomUUID().replaceAll('-', '')
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
  const pairing = new PostgresPairing(sql, config, () => now)
  const proof = new PostgresPairingProof(admin, config, () => now)
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
  async function prepare() {
    const start = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    if (!start.ok) throw new Error('Fixture pairing start failed')
    const challenge = await proof.issue({
      device_code: start.response.device_code,
    })
    if (!challenge.ok) throw new Error('Fixture proof issue failed')
    assert.equal(
      (
        await proof.complete({
          device_code: start.response.device_code,
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
    const account = randomUUID(),
      farm = randomUUID()
    await admin`INSERT INTO farm.session_accounts(id) VALUES(${account})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${account},${account},0,${now},${now},${now + 2000000})`
    await admin`INSERT INTO farm.farms(id) VALUES(${farm}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farm}::uuid,${account},'owner')`
    assert.deepEqual(
      await pairing.decide({
        sessionRecordId: account,
        policy: { idleTimeoutMs: 2000000 },
        decision: 'approve',
        request: {
          user_code: start.response.user_code,
          farm_id: farm,
          expected_fingerprint: identity.fingerprint,
        },
      }),
      { ok: true, status: 'approved' },
    )
    return {
      request: { device_code: start.response.device_code },
      agentId: challenge.challenge.agent_id,
      farmId: farm,
      proofExpiresAt: challenge.challenge.expires_at,
      pairingExpiresAt: start.response.expires_at,
    }
  }
  async function unchanged(item: Awaited<ReturnType<typeof prepare>>) {
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.connector_credentials WHERE agent_id=${item.agentId}::uuid`
      )[0]?.n,
      0,
    )
    assert.equal(
      (
        await admin`SELECT status FROM farm.pairing_requests WHERE agent_id=${item.agentId}::uuid`
      )[0]?.status,
      'approved',
    )
  }
  async function waiting(fragment: string) {
    const deadline = performance.now() + 750
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (rows[0]?.n > 0) return
      assert.ok(performance.now() < deadline, 'Expected lock wait ' + fragment)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    const item = await prepare()
    const results = await Promise.all([
      pairing.claim(item.request, issuer),
      pairing.claim(item.request, issuer),
    ])
    assert.equal(
      results.filter((x) => x.ok && x.status === 'approved').length,
      1,
    )
    assert.equal(
      results.filter((x) => !x.ok && x.reason === 'denied').length,
      1,
    )
    const result = results.find((x) => x.ok && x.status === 'approved')
    if (!result?.ok || result.status !== 'approved')
      throw new Error('Credential was not issued')
    const verified = await verifyConnectorCredential({
      token: result.device_token,
      issuer: issuer.issuer,
      audience: issuer.audience,
      publicKeys: new Map([[issuer.kid, keys.publicKey]]),
      ttlSeconds: issuer.ttlSeconds,
      nowSeconds: Math.floor(now / 1000),
      agentId: item.agentId,
      farmId: item.farmId,
      publicKeySpki: identity.publicKeySpki,
    })
    const metadata = (
      await admin`SELECT jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at::float8,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=${item.agentId}::uuid`
    )[0]
    assert.deepEqual(
      { ...metadata },
      {
        jti: verified.jti,
        agent_id: item.agentId,
        farm_id: item.farmId,
        fingerprint: identity.fingerprint,
        thumbprint: (await connectorKeyBinding(identity.publicKeySpki))
          .thumbprint,
        kid: issuer.kid,
        issuer: issuer.issuer,
        audience: issuer.audience,
        issued_at: verified.issuedAt,
        expires_at: verified.expiresAt,
      },
    )
    assert.equal(result.agent_id, item.agentId)
    assert.equal(result.farm_id, item.farmId)
    assert.equal(result.expires_at, verified.expiresAt * 1000)
    assert.equal(verified.expiresAt - verified.issuedAt, issuer.ttlSeconds)
    const stored = (
      await admin`SELECT row_to_json(c)::text AS value FROM farm.connector_credentials c WHERE agent_id=${item.agentId}::uuid`
    )[0]?.value
    assert.equal(stored.includes(result.device_token), false)
    const columns =
      await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='farm' AND table_name='connector_credentials' ORDER BY ordinal_position`
    assert.deepEqual(
      columns.map((x) => x.column_name),
      [
        'jti',
        'agent_id',
        'farm_id',
        'fingerprint',
        'thumbprint',
        'kid',
        'issuer',
        'audience',
        'issued_at',
        'expires_at',
      ],
    )
    assert.deepEqual(await pairing.claim(item.request, issuer), {
      ok: false,
      reason: 'denied',
    })
    checks.push(
      'real-jose-credential-matches-locked-identity-bounded-metadata-one-racing-winner-no-plaintext-token',
    )

    const failed = await prepare()
    assert.deepEqual(
      await pairing.claim(failed.request, {
        ...issuer,
        privateKey: keys.publicKey,
      }),
      { ok: false, reason: 'storage-unavailable' },
    )
    await unchanged(failed)
    assert.equal((await pairing.claim(failed.request, issuer)).ok, true)
    checks.push(
      'signing-key-error-rolls-back-with-safe-retry-only-before-consumption',
    )

    const commit = await prepare()
    await admin
      .unsafe(
        `CREATE FUNCTION farm.fail_credential_commit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_credential_commit_fixture AFTER INSERT ON farm.connector_credentials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_credential_commit_fixture();`,
      )
      .simple()
    try {
      assert.deepEqual(await pairing.claim(commit.request, issuer), {
        ok: false,
        reason: 'storage-unavailable',
      })
      await unchanged(commit)
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_credential_commit_fixture ON farm.connector_credentials; DROP FUNCTION farm.fail_credential_commit_fixture();',
        )
        .simple()
    }
    assert.equal((await pairing.claim(commit.request, issuer)).ok, true)
    checks.push(
      'deferred-commit-failure-rolls-back-metadata-and-consumption-before-any-token-return',
    )

    for (const scenario of [
      'proof-expiry',
      'pairing-expiry',
      'clock-rollback',
      'token-expiry',
    ]) {
      const expiring = await prepare(),
        initial = now
      const policy = {
        ...issuer,
        ttlSeconds: scenario === 'token-expiry' ? 1 : issuer.ttlSeconds,
      }
      const after =
        scenario === 'proof-expiry'
          ? expiring.proofExpiresAt
          : scenario === 'pairing-expiry'
            ? expiring.pairingExpiresAt
            : scenario === 'clock-rollback'
              ? initial - 1
              : (Math.floor(initial / 1000) + 1) * 1000
      let reads = 0
      const stepped = new PostgresPairing(sql, config, () =>
        ++reads < 4 ? initial : after,
      )
      assert.deepEqual(await stepped.claim(expiring.request, policy), {
        ok: false,
        reason: 'denied',
      })
      assert.ok(reads >= 4)
      await unchanged(expiring)
      if (scenario === 'proof-expiry' || scenario === 'pairing-expiry') {
        assert.equal(
          Number(
            (
              await admin`SELECT proof_expired_at::float8 AS n FROM farm.pairing_requests WHERE agent_id=${expiring.agentId}::uuid`
            )[0]?.n,
          ),
          after,
        )
        assert.deepEqual(await pairing.claim(expiring.request, issuer), {
          ok: false,
          reason: 'denied',
        })
      }
    }
    checks.push(
      'post-async-signing-proof-pairing-token-expiry-and-clock-rollback-never-return-token',
    )

    // A metadata FK wait occurs after signing. Savepoint rollback preserves both the gate and non-consumption.
    const delayed = await prepare()
    const gate = await admin.reserve()
    await gate`BEGIN`
    await gate`SELECT id FROM farm.farms WHERE id=${delayed.farmId}::uuid FOR UPDATE`
    const pending = pairing.claim(delayed.request, issuer)
    try {
      await waiting('INSERT INTO farm.connector_credentials')
      now = delayed.proofExpiresAt
    } finally {
      await gate`COMMIT`
      gate.release()
    }
    assert.deepEqual(await pending, { ok: false, reason: 'denied' })
    await unchanged(delayed)
    assert.equal(
      Number(
        (
          await admin`SELECT proof_expired_at::float8 AS n FROM farm.pairing_requests WHERE agent_id=${delayed.agentId}::uuid`
        )[0]?.n,
      ),
      now,
    )
    checks.push(
      'expiry-after-metadata-foreign-key-wait-rolls-back-insert-and-consumption-durably',
    )

    const snapshot = await prepare()
    const mutable = { ...issuer }
    const snapshotClaim = pairing.claim(snapshot.request, mutable)
    mutable.kid = 'changed-key'
    mutable.ttlSeconds = 1
    const snapshotResult = await snapshotClaim
    assert.ok(snapshotResult.ok && snapshotResult.status === 'approved')
    const snapMetadata = (
      await admin`SELECT kid,expires_at-issued_at AS ttl FROM farm.connector_credentials WHERE agent_id=${snapshot.agentId}::uuid`
    )[0]
    assert.equal(snapMetadata?.kid, issuer.kid)
    assert.equal(Number(snapMetadata?.ttl), issuer.ttlSeconds)
    checks.push('issuer-configuration-snapshotted-before-async-work')

    const constrained = await prepare()
    const iat = Math.floor(now / 1000)
    const base = {
      jti: randomUUID(),
      agent_id: constrained.agentId,
      farm_id: constrained.farmId,
      fingerprint: identity.fingerprint,
      thumbprint: (await connectorKeyBinding(identity.publicKeySpki))
        .thumbprint,
      kid: issuer.kid,
      issuer: issuer.issuer,
      audience: issuer.audience,
      issued_at: iat,
      expires_at: iat + issuer.ttlSeconds,
    }
    for (const patch of [
      { farm_id: item.farmId },
      { fingerprint: 'SHA256:' + 'A'.repeat(43) },
      { thumbprint: 'short' },
      { kid: 'x'.repeat(65) },
      { expires_at: iat + 3601 },
    ])
      await assert.rejects(
        sql`INSERT INTO farm.connector_credentials ${sql({ ...base, ...patch })}`,
      )
    await unchanged(constrained)
    checks.push(
      'metadata-identity-binding-and-field-lifetime-bounds-enforced-by-database',
    )

    for (const query of [
      'UPDATE farm.connector_credentials SET expires_at=expires_at+1',
      'DELETE FROM farm.connector_credentials',
      'TRUNCATE farm.connector_credentials',
      "UPDATE farm.pairing_requests SET status='approved' WHERE status='consumed'",
      'CREATE TABLE farm.forbidden_credential(id int)',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.connector_credentials SET kid='replacement' WHERE agent_id=${item.agentId}::uuid`,
    )
    checks.push('restricted-role-and-immutable-credential-metadata-tombstones')
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
  return checks
}
