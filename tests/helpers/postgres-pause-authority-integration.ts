import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import { readFile, writeFile } from 'node:fs/promises'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresConnectorCredentialAcceptance } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresBrowserDeviceRegistry } from '../../apps/farm/server/storage/postgres-browser-device-registry.ts'
import { PostgresPauseAuthority } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { testPauseAuthorityRetention } from './postgres-pause-authority-catalog.ts'
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
  restartFile?: string,
): Promise<string[]> {
  const cleanup: (() => Promise<unknown>)[] = []
  let primaryError: unknown
  let failed = false
  try {
    const role = 'pause_issuer_fixture_' + randomUUID().replaceAll('-', '')
    await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pause_authority`
    cleanup.push(() => admin`DROP ROLE ${admin(role)}`)
    const acceptorRole =
      'pause_acceptor_fixture_' + randomUUID().replaceAll('-', '')
    await admin`CREATE ROLE ${admin(acceptorRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_connector_credential_acceptor`
    cleanup.push(() => admin`DROP ROLE ${admin(acceptorRole)}`)
    const acceptorSql = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: acceptorRole,
      max: 2,
      connect_timeout: 3,
      connection: {
        application_name: acceptorRole,
        options: '-c role=farm_connector_credential_acceptor',
        statement_timeout: 2000,
        lock_timeout: 1000,
      },
    })
    cleanup.push(() => acceptorSql.end({ timeout: 3 }))
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
    cleanup.push(() => sql.end({ timeout: 3 }))
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
    async function databaseNow(): Promise<number> {
      const now = Number(
        (
          await admin`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now`
        )[0]?.now,
      )
      if (!Number.isSafeInteger(now)) throw new Error('Invalid database clock')
      return now
    }
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
    const sqlstate = (expected: string) => (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === expected
    await assert.rejects(sql`SELECT pg_sleep(3)`, sqlstate('57014'))
    assert.equal((await sql`SELECT 1 AS n`)[0]?.n, 1)
    const timeoutBlocker = await admin.reserve()
    await timeoutBlocker`BEGIN`
    await timeoutBlocker`SELECT id FROM farm.pause_authority_watermark WHERE id=1 FOR UPDATE`
    try {
      await assert.rejects(
        sql`UPDATE farm.pause_authority_watermark SET observed_at=observed_at WHERE id=1`,
        sqlstate('55P03'),
      )
    } finally {
      await timeoutBlocker`ROLLBACK`
      timeoutBlocker.release()
    }
    assert.equal((await sql`SELECT 1 AS n`)[0]?.n, 1)
    // Every individual statement remains below 2s; the server's unmodified 10s
    // transaction_timeout must terminate the transaction itself.
    await assert.rejects(
      sql.begin(async (tx) => {
        for (let i = 0; i < 16; i++) await tx`SELECT pg_sleep(0.75)`
      }),
      sqlstate('25P04'),
    )
    assert.equal((await sql`SELECT 1 AS n`)[0]?.n, 1)
    const now = await databaseNow()
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
        now: await databaseNow(),
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
    await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${assignment}::uuid,${farm}::uuid,${pc.challenge.agent_id}::uuid,${printerKey},${await databaseNow()},${account})`
    const digest = () => randomBytes(32).toString('base64url'),
      issued = await databaseNow()
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
    const watermarkBlocker = await admin.reserve()
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
      const acceptor = new PostgresConnectorCredentialAcceptance(acceptorSql, {
        issuer: origin,
        audience: credentialAudience,
        origin,
        purpose: 'signalling',
        publicKeys: new Map([['fixture', credentialIssuer.publicKey]]),
        ttlSeconds: 300,
        proofTtlMs: 30000,
      })
      pendingInsert = acceptor.issue({
        token: claimed.device_token,
        agentId: pc.challenge.agent_id,
        farmId: farm,
        connectionId: randomUUID(),
      })
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${acceptorRole} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(
          performance.now() < deadline,
          'Expected maintained acceptor parent credential lock wait',
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    } finally {
      await watermarkBlocker`COMMIT`
      watermarkBlocker.release()
    }
    const challenge = await pendingIssue
    const acceptorResult = await pendingInsert
    assert.ok(
      acceptorResult &&
        typeof acceptorResult === 'object' &&
        'ok' in acceptorResult &&
        acceptorResult.ok,
    )
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
    const retentionChecks = await testPauseAuthorityRetention(admin)
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
      const issuedAt = await databaseNow()
      const currentBinding = {
        ...binding,
        transport_id: randomUUID(),
        issued_at: issuedAt,
        expires_at: issuedAt + 30000,
      }
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
    const signingFailure = await authority.issueChallenge(await freshRequest())
    assert.ok(signingFailure.ok)
    const signingProof = await signPauseAdmissionProof(
      signingFailure.challenge,
      browser.privateKey,
    )
    const signingRequest = {
      sessionRecordId: session,
      request: { admissionProofWire: encodePauseAdmissionProof(signingProof) },
    }
    const originalSign = crypto.subtle.sign.bind(crypto.subtle)
    const ownSign = Object.getOwnPropertyDescriptor(crypto.subtle, 'sign')
    Object.defineProperty(crypto.subtle, 'sign', {
      configurable: true,
      value: async (
        algorithm: AlgorithmIdentifier,
        key: CryptoKey,
        data: BufferSource,
      ) => {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
        if (
          new TextDecoder()
            .decode(bytes)
            .startsWith('Open3DFarmManager/pause-capability/v1\0')
        )
          throw new Error('synthetic native signing failure')
        return originalSign(algorithm, key, data)
      },
    })
    try {
      assert.deepEqual(await authority.issueCapability(signingRequest), {
        ok: false,
        reason: 'storage-unavailable',
      })
      const rejectedSigning = (
        await admin`SELECT status,capability_id,capability FROM farm.pause_authority_challenges WHERE challenge_id=${signingFailure.challenge.challenge_id}::uuid`
      )[0]
      assert.deepEqual(
        { ...rejectedSigning },
        { status: 'rejected', capability_id: null, capability: null },
      )
    } finally {
      if (ownSign) Object.defineProperty(crypto.subtle, 'sign', ownSign)
      else Reflect.deleteProperty(crypto.subtle, 'sign')
    }
    assert.deepEqual(await authority.issueCapability(signingRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      {
        ...(
          await admin`SELECT status,capability_id,capability FROM farm.pause_authority_challenges WHERE challenge_id=${signingFailure.challenge.challenge_id}::uuid`
        )[0],
      },
      { status: 'rejected', capability_id: null, capability: null },
    )
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
    // Wrap only the real begin result: the actual DB commit occurs before this
    // synthetic transport loss, modelling a committed response that was lost.
    const lost = await authority.issueChallenge(await freshRequest())
    assert.ok(lost.ok)
    const lostProof = await signPauseAdmissionProof(
      lost.challenge,
      browser.privateKey,
    )
    const lostRequest = {
      sessionRecordId: session,
      request: { admissionProofWire: encodePauseAdmissionProof(lostProof) },
    }
    const lostSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === 'begin')
          return async (callback: (tx: TransactionSql) => Promise<unknown>) => {
            await sql.begin(callback)
            throw new Error('synthetic lost commit response')
          }
        return Reflect.get(target, property, receiver)
      },
    })
    const lostAuthority = new PostgresPauseAuthority(lostSql, {
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
    assert.deepEqual(await lostAuthority.issueCapability(lostRequest), {
      ok: false,
      reason: 'storage-unavailable',
    })
    const lostRow = (
      await admin`SELECT status,capability_id,capability_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${lost.challenge.challenge_id}::uuid`
    )[0]
    assert.equal(lostRow?.status, 'issued')
    assert.ok(lostRow?.capability_id)
    assert.deepEqual(await authority.issueCapability(lostRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      (
        await admin`SELECT status,capability_id,capability_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${lost.challenge.challenge_id}::uuid`
      )[0],
      lostRow,
    )
    const deferred = await authority.issueChallenge(await freshRequest())
    assert.ok(deferred.ok)
    const deferredProof = await signPauseAdmissionProof(
      deferred.challenge,
      browser.privateKey,
    )
    const deferredRequest = {
      sessionRecordId: session,
      request: { admissionProofWire: encodePauseAdmissionProof(deferredProof) },
    }
    await admin
      .unsafe(
        `CREATE FUNCTION farm.test_pause_commit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='issued' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END; $$; CREATE CONSTRAINT TRIGGER test_pause_commit_delay AFTER UPDATE ON farm.pause_authority_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.test_pause_commit_delay();`,
      )
      .simple()
    try {
      const beforeCommitWait = await databaseNow()
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, deferred.challenge.expires_at - beforeCommitWait - 750),
        ),
      )
      assert.deepEqual(await authority.issueCapability(deferredRequest), {
        ok: false,
        reason: 'denied',
      })
      const committedRow = (
        await admin`SELECT status,capability_id,capability_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${deferred.challenge.challenge_id}::uuid`
      )[0]
      assert.equal(committedRow?.status, 'issued')
      assert.ok(committedRow?.capability_id)
      assert.deepEqual(await authority.issueCapability(deferredRequest), {
        ok: false,
        reason: 'denied',
      })
      assert.deepEqual(
        (
          await admin`SELECT status,capability_id,capability_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${deferred.challenge.challenge_id}::uuid`
        )[0],
        committedRow,
      )
    } finally {
      await admin
        .unsafe(
          'DROP TRIGGER test_pause_commit_delay ON farm.pause_authority_challenges; DROP FUNCTION farm.test_pause_commit_delay();',
        )
        .simple()
    }
    // Delay only the response to the real postcommit check transaction. The
    // server clock is untouched and the original challenge deadline is fixed.
    const delayedResponse = await authority.issueChallenge(await freshRequest())
    assert.ok(delayedResponse.ok)
    const delayedResponseProof = await signPauseAdmissionProof(
      delayedResponse.challenge,
      browser.privateKey,
    )
    const delayedResponseRequest = {
      sessionRecordId: session,
      request: {
        admissionProofWire: encodePauseAdmissionProof(delayedResponseProof),
      },
    }
    let beginCount = 0
    const delayedSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === 'begin')
          return async (callback: (tx: TransactionSql) => Promise<unknown>) => {
            beginCount++
            const value = await sql.begin(callback)
            if (beginCount === 2)
              await new Promise((resolve) => setTimeout(resolve, 1000))
            return value
          }
        return Reflect.get(target, property, receiver)
      },
    })
    const delayedAuthority = new PostgresPauseAuthority(delayedSql, {
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
    const beforeResponseWait = await databaseNow()
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(
          0,
          delayedResponse.challenge.expires_at - beforeResponseWait - 750,
        ),
      ),
    )
    assert.deepEqual(
      await delayedAuthority.issueCapability(delayedResponseRequest),
      { ok: false, reason: 'denied' },
    )
    assert.equal(beginCount, 2)
    const delayedRow = (
      await admin`SELECT status,capability_id,capability_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${delayedResponse.challenge.challenge_id}::uuid`
    )[0]
    assert.equal(delayedRow?.status, 'issued')
    assert.ok(delayedRow?.capability_id)
    assert.deepEqual(await authority.issueCapability(delayedResponseRequest), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      (
        await admin`SELECT status,capability_id,capability_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${delayedResponse.challenge.challenge_id}::uuid`
      )[0],
      delayedRow,
    )
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
    const beforeDelay = await databaseNow()
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, delayed.challenge.expires_at - beforeDelay - 300),
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
      const lockedAt = await databaseNow()
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, delayed.challenge.expires_at - lockedAt + 1),
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
    await sessionBlocker`UPDATE farm.account_sessions SET revoked_at=${await databaseNow()} WHERE id=${session}`
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
    const nextNow = await databaseNow()
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${session},${account},0,${nextNow},${nextNow},${nextNow + 1800000})`
    for (const [kind, ordering] of (['key', 'assignment'] as const).flatMap(
      (kind) =>
        (['revoke-first', 'issuer-first'] as const).map(
          (ordering) => [kind, ordering] as const,
        ),
    )) {
      const alternate = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      )
      const exported = await crypto.subtle.exportKey('jwk', alternate.publicKey)
      const alternatePublic = {
        kty: exported.kty,
        crv: exported.crv,
        x: exported.x,
        y: exported.y,
      }
      const registered = await devices.issueChallenge({
        sessionRecordId: session,
        policy,
        request: {
          farm_id: farm,
          public_key: alternatePublic,
          purpose: 'enroll',
        },
      })
      assert.ok(registered.ok)
      assert.ok(
        (
          await devices.completeProof({
            sessionRecordId: session,
            policy,
            request: {
              challenge_id: registered.challenge.challenge_id,
              signature: await signBrowserDeviceProof(
                registered.challenge,
                alternate.privateKey,
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
              key_id: registered.challenge.key_id,
              expected_thumbprint: registered.challenge.thumbprint,
            },
          })
        ).ok,
      )
      const alternateAssignment = randomUUID(),
        assignedAt = await databaseNow()
      await admin`INSERT INTO farm.printer_assignments(id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${alternateAssignment}::uuid,${farm}::uuid,${binding.agent_id}::uuid,${'synthetic-' + kind + '-' + randomUUID()},${assignedAt},${account})`
      const nowBinding = await databaseNow(),
        b = {
          ...binding,
          key_id: registered.challenge.key_id,
          browser_public_key: alternatePublic,
          browser_thumbprint: registered.challenge.thumbprint,
          assignment_id: alternateAssignment,
          transport_id: randomUUID(),
          issued_at: nowBinding,
          expires_at: nowBinding + 30000,
        }
      const pendingChallenge = await authority.issueChallenge({
        sessionRecordId: session,
        request: {
          browserProofWire: encodeControlProof({
            v: 1,
            role: 'browser',
            binding: b,
            signature: await signControlSessionProof(
              b,
              'browser',
              alternate.privateKey,
            ),
          }),
          connectorProofWire: encodeControlProof({
            v: 1,
            role: 'connector',
            binding: b,
            signature: await signControlSessionProof(
              b,
              'connector',
              connectorPrivate,
            ),
          }),
          admissionNonce: digest(),
        },
      })
      assert.ok(pendingChallenge.ok)
      const p = await signPauseAdmissionProof(
          pendingChallenge.challenge,
          alternate.privateKey,
        ),
        requestForProof = {
          sessionRecordId: session,
          request: { admissionProofWire: encodePauseAdmissionProof(p) },
        }
      const revokedAt = await databaseNow()
      if (ordering === 'revoke-first') {
        const lock = await admin.reserve()
        await lock`BEGIN`
        if (kind === 'key')
          await lock`UPDATE farm.browser_device_keys SET status='revoked',revoked_at=${revokedAt},revoked_by=${account} WHERE key_id=${registered.challenge.key_id}::uuid`
        else
          await lock`UPDATE farm.printer_assignments SET revoked_at=${revokedAt},revoked_by=${account} WHERE id=${alternateAssignment}::uuid`
        const pendingAuthority = authority.issueCapability(requestForProof)
        try {
          const deadline = performance.now() + 750
          while (true) {
            const waits =
              await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
            if (waits[0]?.n > 0) break
            assert.ok(
              performance.now() < deadline,
              'Expected key or assignment row lock wait',
            )
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
        } finally {
          await lock`COMMIT`
          lock.release()
        }
        assert.deepEqual(await pendingAuthority, {
          ok: false,
          reason: 'denied',
        })
      } else {
        const blocker = await admin.reserve(),
          mutator = await admin.reserve()
        let blockerOpen = false,
          mutatorOpen = false
        let mutation: Promise<unknown> | undefined
        try {
          await blocker`BEGIN`
          blockerOpen = true
          await blocker`SELECT * FROM farm.pause_authority_watermark FOR UPDATE`
          const pendingAuthority = authority.issueCapability(requestForProof)
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
          const pid = (await mutator`SELECT pg_backend_pid() AS pid`)[0]?.pid
          await mutator`BEGIN`
          mutatorOpen = true
          mutation = Promise.resolve(
            kind === 'key'
              ? mutator`UPDATE farm.browser_device_keys SET status='revoked',revoked_at=${revokedAt},revoked_by=${account} WHERE key_id=${registered.challenge.key_id}::uuid`
              : mutator`UPDATE farm.printer_assignments SET revoked_at=${revokedAt},revoked_by=${account} WHERE id=${alternateAssignment}::uuid`,
          )
          while (true) {
            const waits =
              await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock'`
            if (waits[0]?.n > 0) break
            assert.ok(
              performance.now() < deadline,
              'Expected revocation row lock wait',
            )
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          await blocker`COMMIT`
          blockerOpen = false
          assert.ok((await pendingAuthority).ok)
          await mutation
          await mutator`COMMIT`
          mutatorOpen = false
        } finally {
          if (blockerOpen) await blocker`ROLLBACK`
          if (mutation) await mutation.catch(() => {})
          if (mutatorOpen) await mutator`ROLLBACK`
          blocker.release()
          mutator.release()
        }
      }
      assert.deepEqual(await authority.issueCapability(requestForProof), {
        ok: false,
        reason: 'denied',
      })
    }
    for (const expiryKind of ['idle', 'absolute'] as const) {
      const nearSession = 'session_' + randomUUID(),
        request = { ...(await freshRequest()), sessionRecordId: nearSession },
        created = await databaseNow()
      const lastSeen = expiryKind === 'idle' ? created - 1800000 + 500 : created
      const absoluteExpires =
        expiryKind === 'absolute' ? created + 500 : created + 1800000
      const expires =
        expiryKind === 'idle' ? lastSeen + 1800000 : absoluteExpires
      await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${nearSession},${account},0,${lastSeen},${lastSeen},${absoluteExpires})`
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      await blocker`SELECT id FROM farm.account_sessions WHERE id=${nearSession} FOR UPDATE`
      const pending = authority.issueChallenge(request)
      try {
        const deadline = performance.now() + 750
        while (true) {
          const waits =
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
          if (waits[0]?.n > 0) break
          assert.ok(
            performance.now() < deadline,
            'Expected expiring session row lock wait',
          )
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        while ((await databaseNow()) < expires) {
          assert.ok(
            performance.now() < deadline,
            'Expected session expiry while locked',
          )
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      assert.deepEqual(await pending, { ok: false, reason: 'denied' })
      const row = (
        await admin`SELECT revoked_at::float8 AS revoked_at FROM farm.account_sessions WHERE id=${nearSession}`
      )[0]
      assert.ok(
        typeof row?.revoked_at === 'number' && row.revoked_at >= expires,
      )
    }
    // Budget fixture has its own account and session so earlier tests cannot consume its allowance.
    const budgetAccount = 'budget_' + randomUUID(),
      budgetSession = 'session_' + randomUUID(),
      budgetNow = await databaseNow()
    await admin`INSERT INTO farm.session_accounts(id) VALUES (${budgetAccount})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${budgetSession},${budgetAccount},0,${budgetNow},${budgetNow},${budgetNow + 1800000})`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farm}::uuid,${budgetAccount},'operator')`
    const budgetKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const budgetJwk = await crypto.subtle.exportKey('jwk', budgetKey.publicKey)
    const budgetPublic = {
      kty: budgetJwk.kty,
      crv: budgetJwk.crv,
      x: budgetJwk.x,
      y: budgetJwk.y,
    }
    const budgetEnroll = await devices.issueChallenge({
      sessionRecordId: budgetSession,
      policy,
      request: { farm_id: farm, public_key: budgetPublic, purpose: 'enroll' },
    })
    assert.ok(budgetEnroll.ok)
    assert.ok(
      (
        await devices.completeProof({
          sessionRecordId: budgetSession,
          policy,
          request: {
            challenge_id: budgetEnroll.challenge.challenge_id,
            signature: await signBrowserDeviceProof(
              budgetEnroll.challenge,
              budgetKey.privateKey,
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
            key_id: budgetEnroll.challenge.key_id,
            expected_thumbprint: budgetEnroll.challenge.thumbprint,
          },
        })
      ).ok,
    )
    const budgetChallenge = budgetEnroll.challenge
    async function budgetRequest(sessionRecordId: string) {
      const issuedAt = await databaseNow(),
        b = {
          ...binding,
          transport_id: randomUUID(),
          account_id: budgetAccount,
          key_id: budgetChallenge.key_id,
          browser_public_key: budgetPublic,
          browser_thumbprint: budgetChallenge.thumbprint,
          issued_at: issuedAt,
          expires_at: issuedAt + 30000,
        }
      return {
        sessionRecordId,
        request: {
          browserProofWire: encodeControlProof({
            v: 1,
            role: 'browser',
            binding: b,
            signature: await signControlSessionProof(
              b,
              'browser',
              budgetKey.privateKey,
            ),
          }),
          connectorProofWire: encodeControlProof({
            v: 1,
            role: 'connector',
            binding: b,
            signature: await signControlSessionProof(
              b,
              'connector',
              connectorPrivate,
            ),
          }),
          admissionNonce: digest(),
        },
      }
    }
    for (let i = 0; i < 60; i++)
      assert.ok(
        (await authority.issueChallenge(await budgetRequest(budgetSession))).ok,
      )
    assert.deepEqual(
      await authority.issueChallenge(await budgetRequest(budgetSession)),
      { ok: false, reason: 'rate-limited' },
    )
    const budgetSession2 = 'session_' + randomUUID(),
      secondNow = await databaseNow()
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${budgetSession2},${budgetAccount},0,${secondNow},${secondNow},${secondNow + 1800000})`
    for (let i = 0; i < 4; i++) {
      const next = await authority.issueChallenge(
        await budgetRequest(budgetSession2),
      )
      assert.ok(next.ok)
      if (i === 0 && restartFile) {
        const signedProof = await signPauseAdmissionProof(
          next.challenge,
          budgetKey.privateKey,
        )
        const requestForRestart = {
          sessionRecordId: budgetSession2,
          request: {
            admissionProofWire: encodePauseAdmissionProof(signedProof),
          },
        }
        const issuedForRestart =
          await authority.issueCapability(requestForRestart)
        assert.ok(issuedForRestart.ok)
        await writeFile(
          restartFile,
          JSON.stringify({
            requestForRestart,
            challengeId: next.challenge.challenge_id,
            capabilityId: issuedForRestart.capability.capability_id,
            capabilityExpiresAt: issuedForRestart.capability.expires_at,
          }),
          { flag: 'wx', mode: 0o600 },
        )
      }
    }
    assert.deepEqual(
      await authority.issueChallenge(await budgetRequest(budgetSession2)),
      { ok: false, reason: 'capacity' },
    )
    // Synthetic parents isolate the global cap; this seed deliberately bypasses
    // the independently tested per-account cap in the disposable fixture only.
    const existingGlobal = Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.pause_authority_challenges`
      )[0]?.n,
    )
    assert.ok(existingGlobal <= 4095)
    const globalNow = await databaseNow()
    await admin`INSERT INTO farm.pause_authority_challenges(challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at)
      SELECT gen_random_uuid(),${budgetSession2},${budgetAccount},${farm}::uuid,${binding.agent_id}::uuid,${budgetChallenge.key_id}::uuid,${credential.jti}::uuid,${assignment}::uuid,gen_random_uuid(),rtrim(translate(encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'base64'),'+/','-_'),'='),'{}'::jsonb,'{}'::jsonb,${globalNow},${globalNow + 8000},${globalNow + 8000},${globalNow + 8000}
      FROM generate_series(1,${4095 - existingGlobal})`
    const globalRequests = await Promise.all([freshRequest(), freshRequest()])
    const globalRace = await Promise.all(
      globalRequests.map((item) => authority.issueChallenge(item)),
    )
    assert.equal(globalRace.filter((result) => result.ok).length, 1)
    assert.equal(
      globalRace.filter((result) => !result.ok && result.reason === 'capacity')
        .length,
      1,
    )
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.pause_authority_challenges`
      )[0]?.n,
      4096,
    )
    await admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${account}`
    assert.deepEqual(await authority.issueChallenge(await freshRequest()), {
      ok: false,
      reason: 'denied',
    })
    await admin`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${account}`
    assert.deepEqual(await authority.issueChallenge(await freshRequest()), {
      ok: false,
      reason: 'capacity',
    })
    const versionRequest = await freshRequest(),
      versionBlocker = await admin.reserve()
    await versionBlocker`BEGIN`
    await versionBlocker`UPDATE farm.session_accounts SET session_version=session_version+1 WHERE id=${account}`
    const versionPending = authority.issueChallenge(versionRequest)
    try {
      const deadline = performance.now() + 750
      while (true) {
        const waits =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${role} AND wait_event_type='Lock'`
        if (waits[0]?.n > 0) break
        assert.ok(
          performance.now() < deadline,
          'Expected account version row lock wait',
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    } finally {
      await versionBlocker`COMMIT`
      versionBlocker.release()
    }
    assert.deepEqual(await versionPending, { ok: false, reason: 'denied' })
    session = 'session_' + randomUUID()
    const freshSessionNow = await databaseNow()
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) SELECT ${session},id,session_version,${freshSessionNow},${freshSessionNow},${freshSessionNow + 1800000} FROM farm.session_accounts WHERE id=${account}`
    assert.deepEqual(await authority.issueChallenge(await freshRequest()), {
      ok: false,
      reason: 'capacity',
    })
    const waitingRequest = await freshRequest(),
      blocker = await admin.reserve()
    await blocker`BEGIN`
    await blocker`UPDATE farm.memberships SET revoked_at=${await databaseNow()} WHERE farm_id=${farm}::uuid AND account_id=${account}`
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
      await assert.rejects(sql.unsafe(query), sqlstate('42501'))
    const injectedFutureWatermark =
      process.env.PAUSE_AUTHORITY_SYNTHETIC_FUTURE_WATERMARK === 'yes'
    if (injectedFutureWatermark) {
      const before = (
        await admin`SELECT count(*)::int AS n FROM farm.pause_authority_challenges`
      )[0]?.n
      const future = (await databaseNow()) + 3600000
      await admin`UPDATE farm.pause_authority_watermark SET observed_at=${future} WHERE id=1`
      await assert.rejects(admin`SELECT farm.prune_pause_authority()`)
      assert.equal(
        (
          await admin`SELECT count(*)::int AS n FROM farm.pause_authority_challenges`
        )[0]?.n,
        before,
      )
      assert.equal(
        Number(
          (
            await admin`SELECT observed_at FROM farm.pause_authority_watermark WHERE id=1`
          )[0]?.observed_at,
        ),
        future,
      )
    }
    return [
      ...retentionChecks,
      ...(injectedFutureWatermark
        ? ['injected-future-watermark-prune-denies-before-delete']
        : []),
      'real-2s-statement-1s-lock-10s-transaction-timeouts-and-pool-recovery',
      'real-enrollment-pairing-credential-assignment-dual-proof-and-single-issuance',
      'maintained-acceptor-first-slot-waits-for-parent-lock',
      'key-and-assignment-revocation-row-wait-terminal-denial',
      'durable-replay-denial-and-restricted-role',
      'per-session-sixty-per-account-sixty-four-and-synthetic-global-4096-allocation-bounds',
      'nonce-cross-transport-failed-proof-consumed-current-role-and-membership-row-wait',
      'idle-and-absolute-expiry-after-session-lock-and-account-version-after-account-lock',
      'native-sign-failure-deferred-commit-rollback-committed-lost-response-deferred-commit-expiry-live-retention-expiry-after-lock-disabled-account-and-session-revocation',
    ]
  } catch (error) {
    failed = true
    primaryError = error
    throw error
  } finally {
    const errors: unknown[] = []
    for (const release of cleanup.reverse()) {
      try {
        await release()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(
        failed ? [primaryError, ...errors] : errors,
        'Pause issuer fixture cleanup incomplete',
      )
  }
}

/** Run only in a later process after the caller has restarted the same disposable PostgreSQL cluster. */
export async function verifyPauseAuthorityReplayRestart(
  admin: Sql,
  port: number,
  path: string,
): Promise<string[]> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (
    typeof input !== 'object' ||
    input === null ||
    !('requestForRestart' in input) ||
    !('challengeId' in input) ||
    typeof input.challengeId !== 'string' ||
    !('capabilityId' in input) ||
    typeof input.capabilityId !== 'string' ||
    !('capabilityExpiresAt' in input) ||
    typeof input.capabilityExpiresAt !== 'number'
  )
    throw new Error('Invalid private restart receipt')
  const request = input.requestForRestart
  if (
    typeof request !== 'object' ||
    request === null ||
    !('sessionRecordId' in request) ||
    typeof request.sessionRecordId !== 'string'
  )
    throw new Error('Invalid private restart request')
  const before = (
    await admin`SELECT status,capability_id::text,capability_expires_at::float8 AS expires FROM farm.pause_authority_challenges WHERE challenge_id=${input.challengeId}::uuid`
  )[0]
  assert.deepEqual(
    { ...before },
    {
      status: 'issued',
      capability_id: input.capabilityId,
      expires: input.capabilityExpiresAt,
    },
  )
  const active = (
    await admin`SELECT s.revoked_at,a.disabled,m.revoked_at AS membership_revoked FROM farm.account_sessions s JOIN farm.session_accounts a ON a.id=s.account_id JOIN farm.pause_authority_challenges c ON c.session_id=s.id JOIN farm.memberships m ON m.account_id=a.id AND m.farm_id=c.farm_id WHERE c.challenge_id=${input.challengeId}::uuid`
  )[0]
  assert.deepEqual(
    { ...active },
    { revoked_at: null, disabled: false, membership_revoked: null },
  )
  const role = 'pause_restart_fixture_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pause_authority`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 2,
    connect_timeout: 3,
    connection: {
      options: '-c role=farm_pause_authority',
      statement_timeout: 2000,
      lock_timeout: 1000,
      transaction_timeout: 10000,
    },
  })
  try {
    const nonceConstraint = (
      await admin`SELECT conname FROM pg_constraint WHERE conrelid='farm.pause_authority_challenges'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (agent_id, credential_jti, admission_nonce)'`
    )[0]?.conname
    assert.equal(typeof nonceConstraint, 'string')
    await assert.rejects(
      sql`INSERT INTO farm.pause_authority_challenges (challenge_id,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,transport_id,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at) SELECT ${randomUUID()}::uuid,session_id,account_id,farm_id,agent_id,key_id,credential_jti,assignment_id,${randomUUID()}::uuid,admission_nonce,binding,challenge,issued_at,expires_at,binding_expires_at,credential_expires_at FROM farm.pause_authority_challenges WHERE challenge_id=${input.challengeId}::uuid`,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505' &&
        'constraint_name' in error &&
        error.constraint_name === nonceConstraint,
    )
    await assert.rejects(
      sql`UPDATE farm.pause_authority_challenges SET status='pending' WHERE challenge_id=${input.challengeId}::uuid`,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P0001' &&
        'message' in error &&
        error.message === 'Pause identity and terminal issuance are immutable',
    )
    const issuer = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const authority = new PostgresPauseAuthority(sql, {
      origin: 'https://farm.example',
      audience: 'open3dfarmmanager:pause',
      issuer: 'pause:issuer',
      kid: 'pause-key',
      credentialIssuer: 'https://farm.example',
      credentialAudience: 'open3dfarmmanager:connector',
      idleTimeoutMs: 1800000,
      signingKey: issuer.privateKey,
      verificationKey: issuer.publicKey,
    })
    assert.deepEqual(await authority.issueCapability(request), {
      ok: false,
      reason: 'denied',
    })
    const after = (
      await admin`SELECT status,capability_id::text,capability_expires_at::float8 AS expires FROM farm.pause_authority_challenges WHERE challenge_id=${input.challengeId}::uuid`
    )[0]
    assert.deepEqual({ ...after }, { ...before })
    return [
      'restart-restricted-role-nonce-uniqueness-and-terminal-immutability',
      'restart-old-proof-denied-with-new-synthetic-issuer-key-and-unchanged-capability',
    ]
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
}
