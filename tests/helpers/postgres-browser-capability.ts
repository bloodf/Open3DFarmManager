import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresPauseAuthority } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import {
  encodePauseAdmissionProof,
  type PauseAdmissionChallenge,
  type PauseCapabilityV1,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import type { V2Authority } from './command-v2-dispatch.ts'

export async function issueBrowserCapability(
  fixture: V2Authority,
  connectorClaims: PauseCapabilityV1,
  advertised: unknown,
  ageAtSendMs: number | null = 0,
  role: 'operator' | 'admin' = 'operator',
) {
  const { binding, connector, issuer } = fixture
  const sessionId = 'session_test'
  const now = 2000
  const { x } = await crypto.subtle.exportKey('jwk', connector.publicKey)
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x }))
    .digest('base64url')
  const challenge: PauseAdmissionChallenge = {
    v: 1,
    purpose: 'pause-admission',
    challenge_id: randomUUID(),
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    account_id: binding.account_id,
    browser_thumbprint: binding.browser_thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: connectorClaims.control_binding_sha256,
    admission_nonce: connectorClaims.admission_nonce,
    issued_at: now,
    expires_at: now + 8000,
  }
  const row = {
    challenge_id: challenge.challenge_id,
    session_id: sessionId,
    account_id: binding.account_id,
    binding,
    challenge,
    status: 'pending',
    issued_at: challenge.issued_at,
    expires_at: challenge.expires_at,
  }
  const query = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join('?').trim()
    if (statement.startsWith('SET LOCAL') || statement.startsWith('UPDATE'))
      return []
    if (statement.includes('AS now')) return [{ now, watermark: now }]
    if (
      statement.includes('AS observed_at') &&
      !statement.includes('FROM farm.pause_authority_advertised_controls')
    )
      return [{ observed_at: now }]
    if (statement.includes('FROM farm.pause_authority_challenges')) return [row]
    if (statement.includes('FROM farm.session_accounts'))
      return [{ id: binding.account_id, disabled: false, sessionVersion: 0 }]
    if (statement.includes('FROM farm.account_sessions'))
      return [
        {
          id: sessionId,
          accountId: binding.account_id,
          accountVersion: 0,
          createdAt: binding.issued_at,
          lastSeenAt: now,
          absoluteExpiresAt: now + 1800000,
          revokedAt: null,
        },
      ]
    if (statement.includes('FROM farm.memberships'))
      return [{ role, revoked_at: null }]
    if (statement.includes('FROM farm.browser_device_keys'))
      return [
        {
          status: 'approved',
          public_key: binding.browser_public_key,
          thumbprint: binding.browser_thumbprint,
          approved_at: now,
          revoked_at: null,
        },
      ]
    if (statement.includes('FROM farm.connector_enrollments'))
      return [
        {
          farm_id: binding.farm_id,
          status: 'approved',
          public_key_spki: binding.connector_public_key_spki,
          fingerprint: binding.connector_fingerprint,
        },
      ]
    if (statement.includes('FROM farm.connector_credentials'))
      return [
        {
          farm_id: binding.farm_id,
          fingerprint: binding.connector_fingerprint,
          issuer: binding.origin,
          audience: 'connector:test',
          thumbprint,
          issued_at: 1,
          expires_at: 60,
        },
      ]
    if (
      statement.includes('FROM farm.connector_credential_proofs') ||
      statement.includes('FROM farm.connector_revocations')
    )
      return []
    if (statement.includes('FROM farm.printer_assignments'))
      return [
        {
          farm_id: binding.farm_id,
          agent_id: binding.agent_id,
          printer_key: fixture.printerKey,
          revoked_at: null,
        },
      ]
    if (statement.includes('FROM farm.pause_authority_advertised_controls')) {
      assert.deepEqual(values, [
        binding.farm_id,
        binding.agent_id,
        fixture.printerKey,
      ])
      return advertised === undefined
        ? []
        : [
            {
              controls: advertised,
              age_at_send_ms: ageAtSendMs,
              observed_at: now,
              received_at: now,
            },
          ]
    }
    assert.fail(`Unexpected fixture query: ${statement}`)
  }
  const tx = Object.assign(query, {
    savepoint: (fn: (sql: unknown) => unknown) => fn(tx),
    json: (value: unknown) => value,
  })
  const sql = { begin: (fn: (sql: unknown) => unknown) => fn(tx) } as Sql
  const authority = new PostgresPauseAuthority(sql, {
    origin: binding.origin,
    audience: binding.audience,
    issuer: connectorClaims.issuer,
    kid: connectorClaims.kid,
    credentialIssuer: binding.origin,
    credentialAudience: 'connector:test',
    idleTimeoutMs: 1800000,
    signingKey: issuer.privateKey,
    verificationKey: issuer.publicKey,
  })
  return authority.issueCapability({
    sessionRecordId: sessionId,
    request: {
      admissionProofWire: encodePauseAdmissionProof(
        await fixture.signer.signAdmissionProof(challenge),
      ),
    },
  })
}
