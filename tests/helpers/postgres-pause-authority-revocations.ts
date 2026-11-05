import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import postgres, { type Sql, type ReservedSql } from 'postgres'
import { PostgresPairing } from '../../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresBrowserDeviceRegistry } from '../../apps/farm/server/storage/postgres-browser-device-registry.ts'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'
import { PostgresConnectorRevocation } from '../../apps/farm/server/storage/postgres-connector-revocation.ts'
import { PostgresPauseAuthority } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  BrowserDevicePublicKey,
  BrowserDeviceUuid,
  signBrowserDeviceProof,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  ControlSessionBinding,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseAdmissionProof,
  signPauseAdmissionProof,
  verifyPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'

type Mode =
  | 'enrollment-only'
  | 'synthetic-credential-expiry-marker'
  | 'maintained-connector-revoker'

/** Prepared synthetic PostgreSQL cases. The caller owns the disposable migrated cluster.
 * Enrollment-only mutations and synthetic credential markers isolate individual gates;
 * only the maintained-revoker cases claim to exercise the actual revocation API lifecycle.
 */
export async function testPauseConnectorRevocations(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const prefix = 'pause_revoke_' + randomUUID().replaceAll('-', '')
  const issuerRole = prefix + '_issuer',
    revokerRole = prefix + '_revoker'
  const roles: string[] = []
  let issuerSql: Sql | undefined, revokerSql: Sql | undefined
  const checks: string[] = []
  const cleanupFailures: string[] = []
  async function releaseReservation(connection: ReservedSql, open: boolean) {
    try {
      if (open) await connection`ROLLBACK`
    } catch {
      cleanupFailures.push('reservation rollback')
    } finally {
      try {
        connection.release()
      } catch {
        cleanupFailures.push('reservation release')
      }
    }
  }
  async function now() {
    const value = Number(
      (
        await admin`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS now`
      )[0]?.now,
    )
    assert.ok(Number.isSafeInteger(value) && value >= 0)
    return value
  }
  const track = <T>(pending: Promise<T>) => {
    void pending.catch(() => {})
    return pending
  }
  async function waitForLock(application: string, fragment: string) {
    const deadline = performance.now() + 750
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${application} AND state='active' AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (rows[0]?.n > 0) return
      assert.ok(
        performance.now() < deadline,
        'Expected bounded task-owned row lock wait',
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  async function fixture(issuerPool: Sql, revokerPool: Sql) {
    const account = 'issuer_' + randomUUID(),
      adminAccount = 'revoker_' + randomUUID()
    const session = 'session_' + randomUUID(),
      adminSession = 'session_' + randomUUID(),
      farm = randomUUID()
    const timestamp = await now(),
      policy = { idleTimeoutMs: 1800000 }
    await admin`INSERT INTO farm.session_accounts(id) VALUES(${account}),(${adminAccount})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${session},${account},0,${timestamp},${timestamp},${timestamp + 1800000}),(${adminSession},${adminAccount},0,${timestamp},${timestamp},${timestamp + 1800000})`
    await admin`INSERT INTO farm.farms(id) VALUES(${farm}::uuid)`
    await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farm}::uuid,${account},'owner'),(${farm}::uuid,${adminAccount},'admin')`
    const origin = 'https://farm.example',
      audience = 'open3dfarmmanager:pause',
      credentialAudience = 'open3dfarmmanager:connector'
    const identityKeys = generateKeyPairSync('ed25519'),
      identity = new ConnectorIdentity(identityKeys.privateKey)
    const connectorPrivate = await crypto.subtle.importKey(
      'pkcs8',
      identityKeys.privateKey.export({ type: 'pkcs8', format: 'der' }),
      'Ed25519',
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
    const pairingConfig = { origin, audience: 'open3dfarmmanager:pairing' }
    const pairing = new PostgresPairing(admin, pairingConfig),
      pairingProof = new PostgresPairingProof(admin, pairingConfig)
    const started = await pairing.start({
      public_key_spki: identity.publicKeySpki,
      platform: 'linux',
      version: '0.0.1',
    })
    assert.ok(started.ok)
    const proof = await pairingProof.issue({
      device_code: started.response.device_code,
    })
    assert.ok(proof.ok)
    const agentId = proof.challenge.agent_id
    assert.ok(
      (
        await pairingProof.complete({
          device_code: started.response.device_code,
          challenge: proof.challenge,
          signature: identity.signPairingProof({
            challenge: proof.challenge,
            expectedOrigin: origin,
            expectedAudience: pairingConfig.audience,
            now: await now(),
          }),
        })
      ).ok,
    )
    assert.ok(
      (
        await pairing.decide({
          sessionRecordId: session,
          policy,
          decision: 'approve',
          request: {
            user_code: started.response.user_code,
            farm_id: farm,
            expected_fingerprint: identity.fingerprint,
          },
        })
      ).ok,
    )
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
    const jti = BrowserDeviceUuid.parse(
      (
        await admin`SELECT jti FROM farm.connector_credentials WHERE agent_id=${agentId}::uuid`
      )[0]?.jti,
    )
    const browser = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
    const publicKey = BrowserDevicePublicKey.parse({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    })
    const devices = new PostgresBrowserDeviceRegistry(admin, {
      origin,
      audience: 'open3dfarmmanager:browser-device',
    })
    const enrollment = await devices.issueChallenge({
      sessionRecordId: session,
      policy,
      request: { farm_id: farm, public_key: publicKey, purpose: 'enroll' },
    })
    assert.ok(enrollment.ok)
    const keyId = enrollment.challenge.key_id,
      thumbprint = enrollment.challenge.thumbprint
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
            key_id: keyId,
            expected_thumbprint: thumbprint,
          },
        })
      ).ok,
    )
    const ownership = new PostgresPrinterOwnership(admin)
    const printerKey = 'synthetic-revocation-' + randomUUID()
    const assignment = await ownership.register({
      sessionRecordId: session,
      policy,
      farmId: farm,
      agentId,
      printerKey,
    })
    assert.ok(assignment.ok && assignment.status === 'active')
    const assignmentId = assignment.assignmentId
    const authority = new PostgresPauseAuthority(issuerPool, {
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
    async function freshRequest() {
      const issuedAt = await now(),
        digest = () => randomBytes(32).toString('base64url')
      const binding = ControlSessionBinding.parse({
        v: 1,
        purpose: 'pause-rtc',
        transport_id: randomUUID(),
        farm_id: farm,
        agent_id: agentId,
        account_id: account,
        key_id: keyId,
        assignment_id: assignmentId,
        browser_public_key: publicKey,
        browser_thumbprint: thumbprint,
        connector_public_key_spki: identity.publicKeySpki,
        connector_fingerprint: identity.fingerprint,
        credential_jti: jti,
        origin,
        audience,
        browser_nonce: digest(),
        connector_nonce: digest(),
        issued_at: issuedAt,
        expires_at: issuedAt + 30000,
        offer_sha256: digest(),
        answer_sha256: digest(),
        browser_dtls: Array(32).fill('AA').join(':'),
        connector_dtls: Array(32).fill('BB').join(':'),
      })
      return {
        sessionRecordId: session,
        request: {
          browserProofWire: encodeControlProof({
            v: 1,
            role: 'browser',
            binding,
            signature: await signControlSessionProof(
              binding,
              'browser',
              browser.privateKey,
            ),
          }),
          connectorProofWire: encodeControlProof({
            v: 1,
            role: 'connector',
            binding,
            signature: await signControlSessionProof(
              binding,
              'connector',
              connectorPrivate,
            ),
          }),
          admissionNonce: digest(),
        },
      }
    }
    const challenge = await authority.issueChallenge(await freshRequest())
    assert.ok(challenge.ok)
    const capabilityRequest = {
      sessionRecordId: session,
      request: {
        admissionProofWire: encodePauseAdmissionProof(
          await signPauseAdmissionProof(
            challenge.challenge,
            browser.privateKey,
          ),
        ),
      },
    }
    // Ordinary schema insertion, not a real elapsed expiry. Each marker case gets a fresh row.
    const slotNow = await now()
    await admin`INSERT INTO farm.connector_credential_proofs(jti,observed_at,next_attempt_at) VALUES(${jti}::uuid,${slotNow},${slotNow})`
    const revoker = new PostgresConnectorRevocation(revokerPool)
    async function maintainedRevoke() {
      return revoker.revoke({
        sessionRecordId: adminSession,
        policy,
        farmId: farm,
        agentId,
        expectedFingerprint: identity.fingerprint,
      })
    }
    async function mutate(
      tx: ReservedSql,
      mode: Exclude<Mode, 'maintained-connector-revoker'>,
    ) {
      if (mode === 'enrollment-only')
        await tx`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${agentId}::uuid`
      else {
        const observedAt = await now()
        await tx`UPDATE farm.connector_credential_proofs SET observed_at=greatest(observed_at,${observedAt}),credential_expired_at=${observedAt} WHERE jti=${jti}::uuid`
      }
    }
    async function assertTerminal(mode: Mode) {
      const enrollmentRow = (
        await admin`SELECT status FROM farm.connector_enrollments WHERE agent_id=${agentId}::uuid`
      )[0]
      const tombstones =
        await admin`SELECT credential_jti FROM farm.connector_revocations WHERE agent_id=${agentId}::uuid`
      if (mode === 'synthetic-credential-expiry-marker') {
        assert.equal(enrollmentRow?.status, 'approved')
        assert.equal(tombstones.length, 0)
        assert.ok(
          (
            await admin`SELECT credential_expired_at FROM farm.connector_credential_proofs WHERE jti=${jti}::uuid`
          )[0]?.credential_expired_at !== null,
        )
      } else {
        assert.equal(enrollmentRow?.status, 'revoked')
        if (mode === 'maintained-connector-revoker')
          assert.equal(tombstones[0]?.credential_jti, jti)
        else assert.equal(tombstones.length, 0)
      }
      assert.deepEqual(await authority.issueChallenge(await freshRequest()), {
        ok: false,
        reason: 'denied',
      })
    }
    return {
      authority,
      capabilityRequest,
      session,
      agentId,
      issuer,
      maintainedRevoke,
      mutate,
      assertTerminal,
    }
  }
  try {
    for (const [role, capability] of [
      [issuerRole, 'farm_pause_authority'],
      [revokerRole, 'farm_connector_revoker'],
    ] as const) {
      await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(capability)}`
      roles.push(role)
    }
    const pool = (role: string, capability: string) =>
      postgres({
        host: '127.0.0.1',
        port,
        database: 'fixture',
        username: role,
        max: 2,
        connect_timeout: 3,
        connection: {
          application_name: role,
          options: '-c role=' + capability,
          statement_timeout: 2000,
          lock_timeout: 1000,
          transaction_timeout: 10000,
        },
      })
    issuerSql = pool(issuerRole, 'farm_pause_authority')
    revokerSql = pool(revokerRole, 'farm_connector_revoker')
    for (const mode of [
      'enrollment-only',
      'synthetic-credential-expiry-marker',
      'maintained-connector-revoker',
    ] as const) {
      // Revocation commits while the issuer is blocked on its own session. The
      // maintained revoker has a distinct admin account/session, so it can finish.
      const first = await fixture(issuerSql, revokerSql)
      const blocker = await admin.reserve()
      let open = false
      let pending:
        | ReturnType<typeof first.authority.issueCapability>
        | undefined
      try {
        await blocker`BEGIN`
        open = true
        await blocker`SET LOCAL statement_timeout='2000ms'`
        await blocker`SET LOCAL lock_timeout='1000ms'`
        await blocker`SET LOCAL transaction_timeout='10000ms'`
        await blocker`SELECT id FROM farm.account_sessions WHERE id=${first.session} FOR UPDATE`
        pending = track(
          first.authority.issueCapability(first.capabilityRequest),
        )
        await waitForLock(issuerRole, 'observe_signalling_session_expiry')
        if (mode === 'maintained-connector-revoker')
          assert.ok((await first.maintainedRevoke()).ok)
        else {
          const mutation = await admin.reserve()
          let mutationOpen = false
          try {
            await mutation`BEGIN`
            mutationOpen = true
            await mutation`SET LOCAL statement_timeout='2000ms'`
            await mutation`SET LOCAL lock_timeout='1000ms'`
            await mutation`SET LOCAL transaction_timeout='10000ms'`
            await first.mutate(mutation, mode)
            await mutation`COMMIT`
            mutationOpen = false
          } finally {
            await releaseReservation(mutation, mutationOpen)
          }
        }
        await blocker`COMMIT`
        open = false
        assert.deepEqual(await pending, { ok: false, reason: 'denied' })
        await first.assertTerminal(mode)
        checks.push(mode + '-commit-wins-issuer-session-wait-denies')
      } finally {
        await releaseReservation(blocker, open)
        if (pending) await Promise.allSettled([pending])
      }
      // Authority holds all target row locks while waiting on its own watermark;
      // the independent mutator must wait, then commit only after issuance releases.
      const second = await fixture(issuerSql, revokerSql)
      const watermark = await admin.reserve()
      let watermarkOpen = false
      let mutation: ReservedSql | undefined,
        mutationOpen = false
      let issue: ReturnType<typeof second.authority.issueCapability> | undefined
      let revoke: Promise<unknown> | undefined
      try {
        await watermark`BEGIN`
        watermarkOpen = true
        await watermark`SET LOCAL statement_timeout='2000ms'`
        await watermark`SET LOCAL lock_timeout='1000ms'`
        await watermark`SET LOCAL transaction_timeout='10000ms'`
        await watermark`SELECT id FROM farm.pause_authority_watermark WHERE id=1 FOR UPDATE`
        issue = track(
          second.authority.issueCapability(second.capabilityRequest),
        )
        await waitForLock(issuerRole, 'pause_authority_watermark')
        if (mode === 'maintained-connector-revoker') {
          revoke = track(second.maintainedRevoke())
          await waitForLock(revokerRole, 'connector_enrollments')
        } else {
          mutation = await admin.reserve()
          await mutation`BEGIN`
          mutationOpen = true
          await mutation`SET LOCAL statement_timeout='2000ms'`
          await mutation`SET LOCAL lock_timeout='1000ms'`
          await mutation`SET LOCAL transaction_timeout='10000ms'`
          const name = prefix + '_mutation'
          await mutation`SELECT set_config('application_name',${name},true)`
          revoke = track(second.mutate(mutation, mode))
          await waitForLock(
            name,
            mode === 'enrollment-only'
              ? 'connector_enrollments'
              : 'connector_credential_proofs',
          )
        }
        await watermark`COMMIT`
        watermarkOpen = false
        const issued = await issue
        assert.ok(issued.ok)
        assert.ok(
          await verifyPauseCapability(
            issued.capability,
            second.issuer.publicKey,
          ),
        )
        const revoked = await revoke
        if (mode === 'maintained-connector-revoker')
          assert.ok(
            revoked &&
              typeof revoked === 'object' &&
              'ok' in revoked &&
              revoked.ok === true,
          )
        else {
          assert.ok(mutation)
          await mutation`COMMIT`
          mutationOpen = false
        }
        await second.assertTerminal(mode)
        checks.push(mode + '-issuer-wins-revocation-row-wait-and-later-denial')
      } finally {
        await releaseReservation(watermark, watermarkOpen)
        if (issue) await Promise.allSettled([issue])
        if (revoke) await Promise.allSettled([revoke])
        if (mutation) {
          await releaseReservation(mutation, mutationOpen)
        }
      }
    }
    return checks
  } finally {
    for (const pool of [issuerSql, revokerSql]) {
      try {
        await pool?.end({ timeout: 3 })
      } catch {
        cleanupFailures.push('runtime pool close')
      }
    }
    for (const role of roles.reverse()) {
      try {
        await admin`DROP ROLE ${admin(role)}`
      } catch {
        cleanupFailures.push('runtime role removal')
      }
    }
    if (cleanupFailures.length)
      throw new Error('Pause revocation fixture cleanup incomplete')
    // Synthetic rows/tombstones stay in the caller-owned disposable cluster.
  }
}
