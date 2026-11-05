import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresBrowserDeviceRegistry } from '../../apps/farm/server/storage/postgres-browser-device-registry.ts'
import { PostgresPauseAuthority } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { signBrowserDeviceProof } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseAdmissionProof,
  signPauseAdmissionProof,
  verifyPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'

/** Synthetic caller-owned disposable fixture; real migrations and storage, no physical printers. */
export async function testPostgresPauseAuthority(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const role = 'pause_issuer_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pause_authority`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 4,
    connect_timeout: 3,
    connection: {
      application_name: role,
      options: '-c role=farm_pause_authority',
      statement_timeout: 2000,
      lock_timeout: 1000,
      transaction_timeout: 10000,
    },
  })
  const origin = 'https://farm.example',
    audience = 'open3dfarmmanager:pause',
    credentialAudience = 'open3dfarmmanager:connector'
  const identityKeys = generateKeyPairSync('ed25519'),
    identity = new ConnectorIdentity(identityKeys.privateKey)
  const connectorPrivate = await crypto.subtle.importKey(
    'pkcs8',
    identityKeys.privateKey.export({ type: 'pkcs8', format: 'der' }),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const credentialIssuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    browser.publicKey,
  )
  const publicKey = { kty, crv, x, y },
    account = 'account_' + randomUUID(),
    farm = randomUUID()
  let session = 'session_' + randomUUID()
  const policy = { idleTimeoutMs: 1800000 },
    pairingConfig = { origin, audience: 'open3dfarmmanager:pairing' }
  const pairing = new PostgresPairing(admin, pairingConfig),
    pairingProof = new PostgresPairingProof(admin, pairingConfig)
  const devices = new PostgresBrowserDeviceRegistry(admin, {
    origin,
    audience: 'open3dfarmmanager:browser-device',
  })
  const authority = new PostgresPauseAuthority(sql, {
    origin,
    audience,
    issuer: 'pause:issuer',
    kid: 'pause-key',
    credentialIssuer: origin,
    credentialAudience,
    idleTimeoutMs: 1800000,
    signingKey: issuer.privateKey,
    verificationKey: issuer.publicKey,
  })
  try {
    const settings = (
      await sql`SELECT current_user, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('transaction_timeout') AS transaction`
    )[0]
    assert.deepEqual(
      { ...settings },
      {
        current_user: 'farm_pause_authority',
        statement: '2s',
        lock: '1s',
        transaction: '10s',
      },
    )
    const now = Date.now()
    await admin`INSERT INTO farm.session_accounts(id) VALUES (${account})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${session},${account},0,${now},${now},${now + 1800000})`
    await admin`INSERT INTO farm.farms(id) VALUES (${farm}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farm}::uuid,${account},'owner')`
    const started = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.ok(started.ok)
    const pc = await pairingProof.issue({
      device_code: started.response.device_code,
    })
    assert.ok(pc.ok)
    const completed = await pairingProof.complete({
      device_code: started.response.device_code,
      challenge: pc.challenge,
      signature: identity.signPairingProof({
        challenge: pc.challenge,
        expectedOrigin: origin,
        expectedAudience: pairingConfig.audience,
        now: Date.now(),
      }),
    })
    assert.ok(completed.ok)
    const decision = await pairing.decide({
      sessionRecordId: session,
      policy,
      decision: 'approve',
      request: {
        user_code: started.response.user_code,
        farm_id: farm,
        expected_fingerprint: identity.fingerprint,
      },
    })
    assert.ok(decision.ok)
    const claimed = await pairing.claim(
      { device_code: started.response.device_code },
      {
        issuer: origin,
        audience: credentialAudience,
        kid: 'fixture',
        privateKey: credentialIssuer.privateKey,
        ttlSeconds: 300,
      },
    )
    assert.ok(claimed.ok && claimed.status === 'approved')
    const credential = (
      await admin`SELECT jti FROM farm.connector_credentials WHERE agent_id=${pc.challenge.agent_id}::uuid`
    )[0]
    assert.ok(credential)
    const enrollment = await devices.issueChallenge({
      sessionRecordId: session,
      policy,
      request: { farm_id: farm, public_key: publicKey, purpose: 'enroll' },
    })
    assert.ok(enrollment.ok)
    assert.ok(
      (
        await devices.completeProof({
          sessionRecordId: session,
          policy,
          request: {
            challenge_id: enrollment.challenge.challenge_id,
            signature: await signBrowserDeviceProof(
              enrollment.challenge,
              browser.privateKey,
            ),
          },
        })
      ).ok,
    )
    assert.ok(
      (
        await devices.approve({
          sessionRecordId: session,
          policy,
          request: {
            farm_id: farm,
            key_id: enrollment.challenge.key_id,
            expected_thumbprint: enrollment.challenge.thumbprint,
          },
        })
      ).ok,
    )
    const assignment = randomUUID(),
      printerKey = 'synthetic-printer'
    await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${assignment}::uuid,${farm}::uuid,${pc.challenge.agent_id}::uuid,${printerKey},${Date.now()},${account})`
    const digest = () => randomBytes(32).toString('base64url'),
      issued = Date.now()
    const binding = {
      v: 1 as const,
      purpose: 'pause-rtc' as const,
      transport_id: randomUUID(),
      farm_id: farm,
      agent_id: pc.challenge.agent_id,
      account_id: account,
      key_id: enrollment.challenge.key_id,
      assignment_id: assignment,
      browser_public_key: publicKey,
      browser_thumbprint: enrollment.challenge.thumbprint,
      connector_public_key_spki: identity.publicKeySpki,
      connector_fingerprint: identity.fingerprint,
      credential_jti: credential.jti,
      origin,
      audience,
      browser_nonce: digest(),
      connector_nonce: digest(),
      issued_at: issued,
      expires_at: issued + 30000,
      offer_sha256: digest(),
      answer_sha256: digest(),
      browser_dtls: Array(32).fill('AA').join(':'),
      connector_dtls: Array(32).fill('BB').join(':'),
    }
    const browserSignature = await signControlSessionProof(
        binding,
        'browser',
        browser.privateKey,
      ),
      connectorSignature = await signControlSessionProof(
        binding,
        'connector',
        connectorPrivate,
      )
    const request = {
      sessionRecordId: session,
      request: {
        browserProofWire: encodeControlProof({
          v: 1,
          role: 'browser',
          binding,
          signature: browserSignature,
        }),
        connectorProofWire: encodeControlProof({
          v: 1,
          role: 'connector',
          binding,
          signature: connectorSignature,
        }),
        admissionNonce: digest(),
      },
    }
    // While issuance holds the parent credential row, a concurrent first 0014 slot
    // insertion must wait until that issuance transaction releases its lock.
    const watermarkBlocker = await admin.reserve(),
      inserter = await admin.reserve()
    await watermarkBlocker`BEGIN`
    await watermarkBlocker`SELECT id FROM farm.pause_authority_watermark WHERE id=1 FOR UPDATE`
    const pendingIssue = authority.issueChallenge(request)
    let pendingInsert: Promise<unknown> | undefined
    try {
      const deadline = performance.now() + 750
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(
          performance.now() < deadline,
          'Expected issuer watermark lock wait',
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const pid = (await inserter`SELECT pg_backend_pid() AS pid`)[0]?.pid
      assert.equal(typeof pid, 'number')
      const slotNow = Date.now()
      pendingInsert = Promise.resolve(
        inserter`INSERT INTO farm.connector_credential_proofs(jti,observed_at,next_attempt_at) VALUES (${credential.jti}::uuid,${slotNow},${slotNow})`,
      )
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(
          performance.now() < deadline,
          'Expected first credential-slot insert lock wait',
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    } finally {
      await watermarkBlocker`COMMIT`
      watermarkBlocker.release()
    }
    let challenge: Awaited<typeof pendingIssue>
    try {
      challenge = await pendingIssue
      await pendingInsert
    } finally {
      inserter.release()
    }
    assert.ok(challenge.ok)
    assert.equal(
      challenge.challenge.control_binding_sha256,
      await controlBindingHash(binding),
    )
    const proof = await signPauseAdmissionProof(
        challenge.challenge,
        browser.privateKey,
      ),
      proofRequest = {
        sessionRecordId: session,
        request: { admissionProofWire: encodePauseAdmissionProof(proof) },
      }
    const race = await Promise.all([
      authority.issueCapability(proofRequest),
      authority.issueCapability(proofRequest),
    ])
    assert.equal(race.filter((result) => result.ok).length, 1)
    const success = race.find((result) => result.ok)
    assert.ok(success?.ok)
    assert.equal(
      await verifyPauseCapability(success.capability, issuer.publicKey),
      true,
    )
    assert.equal(success.capability.account_id, account)
    assert.equal(success.capability.printer_key, printerKey)
    assert.ok(
      success.capability.expires_at - success.capability.issued_at <= 30000,
    )
    assert.deepEqual(await authority.issueCapability(proofRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(await authority.issueChallenge(request), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      await authority.issueChallenge({
        ...request,
        sessionRecordId: 'unrelated_session',
      }),
      { ok: false, reason: 'denied' },
    )
    await assert.rejects(
      admin`DELETE FROM farm.pause_authority_challenges WHERE challenge_id=${challenge.challenge.challenge_id}::uuid`,
    )
    await admin`SELECT farm.prune_pause_authority()`
    assert.equal(
      (
        await admin`SELECT status FROM farm.pause_authority_challenges WHERE challenge_id=${challenge.challenge.challenge_id}::uuid`
      )[0]?.status,
      'issued',
    )

    async function freshRequest(admissionNonce = digest()) {
      const currentBinding = { ...binding, transport_id: randomUUID() }
      return {
        sessionRecordId: session,
        request: {
          browserProofWire: encodeControlProof({
            v: 1,
            role: 'browser',
            binding: currentBinding,
            signature: await signControlSessionProof(
              currentBinding,
              'browser',
              browser.privateKey,
            ),
          }),
          connectorProofWire: encodeControlProof({
            v: 1,
            role: 'connector',
            binding: currentBinding,
            signature: await signControlSessionProof(
              currentBinding,
              'connector',
              connectorPrivate,
            ),
          }),
          admissionNonce,
        },
      }
    }
    assert.deepEqual(
      await authority.issueChallenge(
        await freshRequest(request.request.admissionNonce),
      ),
      { ok: false, reason: 'denied' },
    )
    const bad = await authority.issueChallenge(await freshRequest())
    assert.ok(bad.ok)
    const wrong = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const badProof = await signPauseAdmissionProof(
      bad.challenge,
      wrong.privateKey,
    )
    assert.deepEqual(
      await authority.issueCapability({
        sessionRecordId: session,
        request: { admissionProofWire: encodePauseAdmissionProof(badProof) },
      }),
      { ok: false, reason: 'denied' },
    )
    const correct = await signPauseAdmissionProof(
      bad.challenge,
      browser.privateKey,
    )
    assert.deepEqual(
      await authority.issueCapability({
        sessionRecordId: session,
        request: { admissionProofWire: encodePauseAdmissionProof(correct) },
      }),
      { ok: false, reason: 'denied' },
    )
    const status = (
      await admin`SELECT status FROM farm.pause_authority_challenges WHERE challenge_id=${bad.challenge.challenge_id}::uuid`
    )[0]?.status
    assert.equal(status, 'rejected')
    const committed = await authority.issueChallenge(await freshRequest())
    assert.ok(committed.ok)
    const committedProof = await signPauseAdmissionProof(
      committed.challenge,
      browser.privateKey,
    )
    const committedRequest = {
      sessionRecordId: session,
      request: {
        admissionProofWire: encodePauseAdmissionProof(committedProof),
      },
    }
    await admin
      .unsafe(
        `CREATE FUNCTION farm.test_pause_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='issued' THEN RAISE EXCEPTION 'synthetic commit failure'; END IF; RETURN NEW; END; $$; CREATE CONSTRAINT TRIGGER test_pause_commit_failure AFTER UPDATE ON farm.pause_authority_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.test_pause_commit_failure();`,
      )
      .simple()
    try {
      assert.deepEqual(await authority.issueCapability(committedRequest), {
        ok: false,
        reason: 'storage-unavailable',
      })
      assert.equal(
        (
          await admin`SELECT status FROM farm.pause_authority_challenges WHERE challenge_id=${committed.challenge.challenge_id}::uuid`
        )[0]?.status,
        'pending',
      )
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER test_pause_commit_failure ON farm.pause_authority_challenges; DROP FUNCTION farm.test_pause_commit_failure();',
        )
        .simple()
    }
    assert.ok((await authority.issueCapability(committedRequest)).ok)
    const expiry = await authority.issueChallenge(await freshRequest())
    assert.ok(expiry.ok)
    const expiryProof = await signPauseAdmissionProof(
      expiry.challenge,
      browser.privateKey,
    )
    await assert.rejects(
      admin`DELETE FROM farm.pause_authority_challenges WHERE challenge_id=${expiry.challenge.challenge_id}::uuid`,
    )
    await admin`SELECT farm.prune_pause_authority()`
    assert.equal(
      (
        await admin`SELECT status FROM farm.pause_authority_challenges WHERE challenge_id=${expiry.challenge.challenge_id}::uuid`
      )[0]?.status,
      'pending',
    )
    await new Promise((resolve) => setTimeout(resolve, 8100))
    assert.deepEqual(
      await authority.issueCapability({
        sessionRecordId: session,
        request: { admissionProofWire: encodePauseAdmissionProof(expiryProof) },
      }),
      { ok: false, reason: 'denied' },
    )
    assert.equal(
      (
        await admin`SELECT status FROM farm.pause_authority_challenges WHERE challenge_id=${expiry.challenge.challenge_id}::uuid`
      )[0]?.status,
      'expired',
    )
    const delayed = await authority.issueChallenge(await freshRequest())
    assert.ok(delayed.ok)
    const delayedProof = await signPauseAdmissionProof(
      delayed.challenge,
      browser.privateKey,
    )
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, delayed.challenge.expires_at - Date.now() - 300),
      ),
    )
    const expiryBlocker = await admin.reserve()
    await expiryBlocker`BEGIN`
    await expiryBlocker`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${account}`
    const delayedResult = authority.issueCapability({
      sessionRecordId: session,
      request: { admissionProofWire: encodePauseAdmissionProof(delayedProof) },
    })
    try {
      const deadline = performance.now() + 750
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(performance.now() < deadline, 'Expected expiry row lock wait')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, delayed.challenge.expires_at - Date.now() + 1),
        ),
      )
    } finally {
      await expiryBlocker`COMMIT`
      expiryBlocker.release()
    }
    assert.deepEqual(await delayedResult, { ok: false, reason: 'denied' })
    await admin`UPDATE farm.session_accounts SET disabled=true WHERE id=${account}`
    assert.deepEqual(await authority.issueChallenge(await freshRequest()), {
      ok: false,
      reason: 'denied',
    })
    await admin`UPDATE farm.session_accounts SET disabled=false WHERE id=${account}`
    const revoked = await authority.issueChallenge(await freshRequest())
    assert.ok(revoked.ok)
    const revokedProof = await signPauseAdmissionProof(
      revoked.challenge,
      browser.privateKey,
    )
    const sessionBlocker = await admin.reserve()
    await sessionBlocker`BEGIN`
    await sessionBlocker`UPDATE farm.account_sessions SET revoked_at=${Date.now()} WHERE id=${session}`
    const pendingRevocation = authority.issueCapability({
      sessionRecordId: session,
      request: { admissionProofWire: encodePauseAdmissionProof(revokedProof) },
    })
    try {
      const deadline = performance.now() + 750
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(
          performance.now() < deadline,
          'Expected session row lock wait',
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    } finally {
      await sessionBlocker`COMMIT`
      sessionBlocker.release()
    }
    assert.deepEqual(await pendingRevocation, { ok: false, reason: 'denied' })
    session = 'session_' + randomUUID()
    const nextNow = Date.now()
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${session},${account},0,${nextNow},${nextNow},${nextNow + 1800000})`
    await admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${account}`
    assert.deepEqual(await authority.issueChallenge(await freshRequest()), {
      ok: false,
      reason: 'denied',
    })
    await admin`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${account}`
    const waitingRequest = await freshRequest(),
      blocker = await admin.reserve()
    await blocker`BEGIN`
    await blocker`UPDATE farm.memberships SET revoked_at=${Date.now()} WHERE farm_id=${farm}::uuid AND account_id=${account}`
    const pending = authority.issueChallenge(waitingRequest)
    try {
      const deadline = performance.now() + 750
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(
          performance.now() < deadline,
          'Expected membership row lock wait',
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    } finally {
      await blocker`COMMIT`
      blocker.release()
    }
    assert.deepEqual(await pending, { ok: false, reason: 'denied' })
    for (const query of [
      'DELETE FROM farm.pause_authority_challenges',
      'TRUNCATE farm.pause_authority_challenges',
      'CREATE TABLE farm.forbidden_pause_fixture(id int)',
      'UPDATE farm.session_accounts SET disabled=true',
      "UPDATE farm.memberships SET role='owner'",
      "UPDATE farm.browser_device_keys SET status='approved'",
      'UPDATE farm.connector_credentials SET expires_at=expires_at+1',
      'UPDATE farm.printer_assignments SET printer_key=printer_key',
      'SET ROLE fixture',
    ])
      await assert.rejects(sql.unsafe(query))
    return [
      'real-enrollment-pairing-credential-assignment-dual-proof-and-single-issuance',
      'absent-credential-slot-insertion-waits-for-parent-lock',
      'durable-replay-denial-and-restricted-role',
      'nonce-cross-transport-failed-proof-consumed-current-role-and-membership-row-wait',
      'deferred-commit-rollback-live-retention-expiry-after-lock-disabled-account-and-session-revocation',
    ]
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
}
