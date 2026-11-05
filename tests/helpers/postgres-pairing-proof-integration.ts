import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import postgres, { type Sql } from 'postgres'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { signPairingProof } from '../../packages/connector/src/identity/pairing-proof.ts'
import {
  pairingProofPayload,
  type PairingProofChallenge,
} from '../../packages/farm-protocol/src/pairing-proof.ts'

/** Dedicated caller-owned fixture with migrations 0001–0008. No service restart or hardware access. */
export async function testPostgresPairingProof(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const role = 'pairing_proof_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pairing_proof_runtime`
  const connection = {
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 6,
    connect_timeout: 3,
    connection: { application_name: role },
  }
  const sql = postgres(connection)
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
  const proof = new PostgresPairingProof(sql, config, () => now)
  const pairing = new PostgresPairing(admin, () => now)
  const keys = generateKeyPairSync('ed25519')
  const identity = new ConnectorIdentity(keys.privateKey)
  const checks: string[] = []
  async function start() {
    const result = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.ok(result.ok)
    if (!result.ok) throw new Error('Pairing start failed')
    return { device_code: result.response.device_code }
  }
  async function issue(device: Awaited<ReturnType<typeof start>>) {
    const result = await proof.issue(device)
    if (!result.ok) throw new Error('Proof issuance failed: ' + result.reason)
    return result.challenge
  }
  function completion(
    device: Awaited<ReturnType<typeof start>>,
    challenge: PairingProofChallenge,
  ) {
    return {
      ...device,
      challenge,
      signature: signPairingProof({
        challenge,
        privateKey: keys.privateKey,
        expectedOrigin: config.origin,
        expectedAudience: config.audience,
        now,
      }),
    }
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
  async function state(challenge: PairingProofChallenge) {
    return (
      await admin`SELECT status FROM farm.pairing_proofs WHERE nonce = ${challenge.nonce}`
    )[0]?.status
  }
  try {
    assert.deepEqual(
      await proof.issue({ device_code: randomBytes(32).toString('base64url') }),
      { ok: false, reason: 'denied' },
    )
    const device = await start()
    const challenge = await issue(device)
    assert.equal(challenge.expires_at - challenge.issued_at, 60000)
    assert.equal(challenge.public_key_spki, identity.publicKeySpki)
    assert.equal(challenge.fingerprint, identity.fingerprint)
    assert.deepEqual(await proof.issue(device), {
      ok: false,
      reason: 'slow-down',
      retryAfterS: 5,
    })
    now += 5000
    assert.deepEqual(await issue(device), challenge)
    const otherDevice = await start()
    const other = await issue(otherDevice)
    const request = completion(device, challenge)
    for (const patch of [
      { device_code: otherDevice.device_code },
      { device_code: randomBytes(32).toString('base64url') },
      { challenge: { ...challenge, nonce: other.nonce } },
      { challenge: { ...challenge, agent_id: other.agent_id } },
      { challenge: { ...challenge, origin: 'https://other.example' } },
      { challenge: { ...challenge, audience: 'another:audience' } },
      { challenge: { ...challenge, fingerprint: 'SHA256:' + 'A'.repeat(43) } },
    ])
      assert.deepEqual(await proof.complete({ ...request, ...patch }), {
        ok: false,
        reason: 'denied',
      })
    assert.equal(await state(challenge), 'pending')
    assert.equal(await state(other), 'pending')
    assert.deepEqual(
      await new PostgresPairingProof(
        sql,
        { ...config, origin: 'https://other.example' },
        () => now,
      ).complete(request),
      { ok: false, reason: 'denied' },
    )
    assert.deepEqual(
      await proof.complete({ ...request, signature: request.signature + '=' }),
      { ok: false, reason: 'invalid-input' },
    )
    assert.equal(await state(challenge), 'pending')
    const race = await Promise.all([
      proof.complete(request),
      new PostgresPairingProof(sql, config, () => now).complete(request),
    ])
    assert.equal(race.filter((x) => x.ok).length, 1)
    assert.equal(race.filter((x) => !x.ok && x.reason === 'denied').length, 1)
    assert.equal(await state(challenge), 'verified')
    assert.deepEqual(await proof.complete(request), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await proof.issue(device), { ok: false, reason: 'denied' })
    checks.push(
      'persisted-binding-domain-origin-audience-device-secret-unrelated-input-and-racing-replay',
    )

    // Bad signature burns only the exact addressed attempt, not a different pairing.
    const invalid = await start()
    let invalidChallenge = await issue(invalid)
    const wrongKey = generateKeyPairSync('ed25519').privateKey
    const invalidRequest = {
      ...invalid,
      challenge: invalidChallenge,
      signature: sign(
        null,
        pairingProofPayload(invalidChallenge),
        wrongKey,
      ).toString('base64url'),
    }
    assert.deepEqual(await proof.complete(invalidRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(await state(invalidChallenge), 'rejected')
    assert.equal(await state(other), 'pending')
    assert.deepEqual(await proof.issue(invalid), {
      ok: false,
      reason: 'slow-down',
      retryAfterS: 5,
    })
    for (let attempt = 2; attempt <= 3; attempt++) {
      now += 5000
      invalidChallenge = await issue(invalid)
      assert.notEqual(invalidChallenge.nonce, invalidRequest.challenge.nonce)
      assert.deepEqual(
        await proof.complete({
          ...invalid,
          challenge: invalidChallenge,
          signature: sign(
            null,
            pairingProofPayload(invalidChallenge),
            wrongKey,
          ).toString('base64url'),
        }),
        { ok: false, reason: 'denied' },
      )
    }
    now += 5000
    assert.deepEqual(await proof.issue(invalid), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.pairing_proofs WHERE agent_id = ${invalidChallenge.agent_id}::uuid`
      )[0]?.n,
      3,
    )
    checks.push(
      'bad-signature-attempt-consumption-five-second-retries-three-attempt-limit',
    )

    const expiredDevice = await start()
    const expired = await issue(expiredDevice)
    const expiredRequest = completion(expiredDevice, expired)
    now = expired.expires_at
    assert.deepEqual(await proof.complete(expiredRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(await state(expired), 'expired')
    const replacement = await issue(expiredDevice)
    assert.notEqual(replacement.nonce, expired.nonce)
    assert.deepEqual(await proof.complete(expiredRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(await state(replacement), 'pending')
    assert.equal(
      (await proof.complete(completion(expiredDevice, replacement))).ok,
      true,
    )
    checks.push(
      'exact-expiry-replacement-within-pairing-and-old-nonce-cannot-burn-replacement',
    )

    // Request lock and proof lock are both possible waits; clock must follow both.
    for (const target of ['pairing', 'proof']) {
      const delayedDevice = await start()
      const delayed = await issue(delayedDevice)
      const delayedRequest = completion(delayedDevice, delayed)
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      if (target === 'pairing')
        await blocker`SELECT agent_id FROM farm.pairing_requests WHERE agent_id = ${delayed.agent_id}::uuid FOR UPDATE`
      else
        await blocker`SELECT agent_id FROM farm.pairing_proofs WHERE agent_id = ${delayed.agent_id}::uuid FOR UPDATE`
      const pending = proof.complete(delayedRequest)
      try {
        await waitForLock(
          target === 'pairing'
            ? 'FROM farm.pairing_requests'
            : 'FROM farm.pairing_proofs',
        )
        now = delayed.expires_at
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      assert.deepEqual(await pending, { ok: false, reason: 'denied' })
      assert.equal(await state(delayed), 'expired')
    }
    const retiredDevice = await start()
    const retired = await issue(retiredDevice)
    const retiredRequest = completion(retiredDevice, retired)
    await admin`UPDATE farm.pairing_requests SET status = 'denied' WHERE agent_id = ${retired.agent_id}::uuid`
    assert.deepEqual(await proof.complete(retiredRequest), {
      ok: false,
      reason: 'denied',
    })
    checks.push('post-pairing-and-proof-lock-expiry-and-terminal-pairing-deny')

    const boundaryDevice = await start()
    // A challenge near the pairing deadline may be shorter than sixty seconds.
    now += 899999
    const boundary = await issue(boundaryDevice)
    assert.equal(boundary.expires_at - boundary.issued_at, 1)
    const boundaryRequest = completion(boundaryDevice, boundary)
    now += 1
    assert.deepEqual(await proof.complete(boundaryRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await proof.issue(boundaryDevice), {
      ok: false,
      reason: 'denied',
    })
    checks.push('challenge-deadline-never-outlives-pairing')

    const rollbackDevice = await start()
    const rollback = await issue(rollbackDevice)
    const rollbackRequest = completion(rollbackDevice, rollback)
    await admin
      .unsafe(
        `CREATE FUNCTION farm.fail_pairing_proof_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_pairing_proof_fixture AFTER UPDATE ON farm.pairing_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_pairing_proof_fixture();`,
      )
      .simple()
    try {
      assert.deepEqual(await proof.complete(rollbackRequest), {
        ok: false,
        reason: 'storage-unavailable',
      })
      assert.equal(await state(rollback), 'pending')
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER fail_pairing_proof_fixture ON farm.pairing_proofs; DROP FUNCTION farm.fail_pairing_proof_fixture();',
        )
        .simple()
    }
    assert.equal((await proof.complete(rollbackRequest)).ok, true)
    checks.push(
      'deferred-commit-failure-does-not-report-success-or-consume-proof',
    )

    // A fresh OS process has no in-memory challenge registry. It must load the committed DB binding.
    const restartDevice = await start()
    const restart = await issue(restartDevice)
    const restartRequest = completion(restartDevice, restart)
    const program = `import postgres from 'postgres'; import {PostgresPairingProof} from './apps/farm/server/storage/postgres-pairing-proof.ts'; let text=''; for await(const chunk of process.stdin) text+=chunk; const input=JSON.parse(text); const sql=postgres(input.connection); try {const proof=new PostgresPairingProof(sql,input.config,()=>input.now); console.log(JSON.stringify(await proof.complete(input.request)))} finally {await sql.end({timeout:3})}`
    const child = spawn(process.execPath, ['--eval', program], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Proof child timed out'))
      }, 5000)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        code === 0
          ? resolve(stdout)
          : reject(new Error('Proof child failed: ' + stderr.slice(0, 1000)))
      })
      child.stdin.end(
        JSON.stringify({ connection, config, now, request: restartRequest }),
      )
    })
    assert.deepEqual(JSON.parse(output), {
      ok: true,
      status: 'verified',
      agentId: restart.agent_id,
      fingerprint: restart.fingerprint,
    })
    assert.deepEqual(await proof.complete(restartRequest), {
      ok: false,
      reason: 'denied',
    })
    checks.push(
      'fresh-process-completion-and-durable-cross-process-replay-denial',
    )

    for (const query of [
      'DELETE FROM farm.pairing_proofs',
      'TRUNCATE farm.pairing_proofs',
      "UPDATE farm.pairing_proofs SET nonce = repeat('A',43)",
      "UPDATE farm.pairing_proofs SET origin = 'https://other.example'",
      "UPDATE farm.pairing_proofs SET status = 'pending', consumed_at = NULL WHERE status = 'verified'",
      "UPDATE farm.pairing_requests SET fingerprint = 'SHA256:' || repeat('A',43)",
      "UPDATE farm.pairing_requests SET status = 'approved'",
      'UPDATE farm.session_accounts SET disabled = false',
      'CREATE TABLE farm.forbidden_proof (id int)',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    await assert.rejects(
      admin`UPDATE farm.pairing_proofs SET nonce = ${randomBytes(32).toString('base64url')} WHERE nonce = ${restart.nonce}`,
    )
    checks.push('restricted-capability-and-database-immutable-proof-tombstones')
    // Isolate the proof layer's cap with synthetic parents, bypassing the independently tested pairing-start cap.
    now += 900000
    const capacityA = await start()
    const capacityB = await start()
    await admin`WITH parents AS (
      INSERT INTO farm.pairing_requests (agent_id, device_code_hash, user_code_hash, public_key_spki, fingerprint, platform, version, issued_at, expires_at, next_poll_at)
      SELECT gen_random_uuid(), encode(sha256(convert_to('proof-device-' || gen_random_uuid()::text, 'UTF8')), 'hex'), encode(sha256(convert_to('proof-user-' || gen_random_uuid()::text, 'UTF8')), 'hex'), ${identity.publicKeySpki}, ${identity.fingerprint}, 'linux', '0.0.1', ${now}, ${now + 900000}, ${now} FROM generate_series(1, 999) RETURNING agent_id
    ) INSERT INTO farm.pairing_proofs (agent_id, attempt, nonce, origin, audience, issued_at, expires_at, next_poll_at)
      SELECT agent_id, 1, rtrim(translate(encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'base64'), '+/', '-_'), '='), ${config.origin}, ${config.audience}, ${now}, ${now + 60000}, ${now + 5000} FROM parents`
    const capacity = await Promise.all([
      proof.issue(capacityA),
      proof.issue(capacityB),
    ])
    assert.equal(capacity.filter((x) => x.ok).length, 1)
    assert.equal(
      capacity.filter((x) => !x.ok && x.reason === 'capacity').length,
      1,
    )
    now += 60000
    assert.ok((await proof.issue(capacity[0]?.ok ? capacityB : capacityA)).ok)
    checks.push(
      'global-thousand-active-proof-cap-racing-issuance-and-expiry-release',
    )
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
  assert.deepEqual(
    await proof.issue({ device_code: randomBytes(32).toString('base64url') }),
    { ok: false, reason: 'storage-unavailable' },
  )
  return [...checks, 'closed-storage-fails-closed']
}
