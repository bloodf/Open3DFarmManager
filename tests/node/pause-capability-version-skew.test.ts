import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { Sql } from 'postgres'
import { z } from 'zod'
import { PostgresPauseAuthority } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  type PauseAdmissionChallenge,
  type PauseCapabilityV1,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import type { V2Authority } from '../helpers/command-v2-dispatch.ts'

// Frozen from the last protocol before #787. The issuer and test run against
// current code, while the Connector's admission decoder uses the old enum.
const previousActions = [
  'pause',
  'resume',
  'cancel',
  'emergency_stop',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'start_print',
  'start_library_print',
  'firmware_restart',
  'service',
  'power',
  'timelapse',
  'run_macro',
  'config_write',
  'load_filament',
  'unload_filament',
  'jog',
  'motors_off',
  'z_babystep',
  'set_factor',
  'extrude',
  'file_op',
  'exclude_object',
  'set_led',
  'set_pin',
  'queue_op',
  'bed_mesh',
  'gcode',
  'confirm_collection',
] as const
const previousActionList = z
  .array(z.enum(previousActions))
  .min(1)
  .max(previousActions.length)
const protocolUrl = new URL(
  '../../packages/farm-protocol/src/pause-capability.ts',
  import.meta.url,
).href
const previousModule =
  'data:text/javascript,' +
  encodeURIComponent(`
  import { decodePauseCapability as decode, SignedPauseCapabilityV1 } from ${JSON.stringify(protocolUrl)}
  export * from ${JSON.stringify(protocolUrl)}
  export function decodePauseCapability(input) {
    const capability = JSON.parse(input)
    if (capability.actions.some(action => !${JSON.stringify(previousActions)}.includes(action))) {
      throw new Error('Unsupported action in legacy capability')
    }
    return SignedPauseCapabilityV1.parse(decode(input))
  }
`)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    if (
      context.parentURL?.endsWith('/connector/src/auth/pause-capability.ts') &&
      resolved.url === protocolUrl
    )
      return { url: previousModule, shortCircuit: true }
    return resolved
  },
})
const { createV2Authority, nodeSigner, openV2Dispatch } =
  await import('../helpers/command-v2-dispatch.ts').finally(() =>
    hooks.deregister(),
  )

async function issue(
  fixture: V2Authority,
  connectorClaims: PauseCapabilityV1,
  advertised: unknown,
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
    if (statement.includes('AS observed_at')) return [{ observed_at: now }]
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
      return [{ role: 'operator', revoked_at: null }]
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
      return advertised === undefined ? [] : [{ controls: advertised }]
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

test('the new issuer capability is admitted by the previous action enum and dispatches pause', async (t) => {
  const fixture = await createV2Authority(await nodeSigner())
  let actions: string[] | undefined
  let capabilityId: string | undefined
  const dispatcher = await openV2Dispatch(fixture, {
    now: 2000,
    async capabilityWire(claims) {
      const issued = await issue(fixture, claims, [
        'pause',
        'resume',
        'cancel',
        'emergency_stop',
        'set_temperature',
        'power',
        'future_action',
      ])
      assert.ok(issued.ok)
      actions = issued.capability.actions
      capabilityId = issued.capability.capability_id
      return encodePauseCapability(issued.capability)
    },
  })
  t.after(() => dispatcher.close())
  assert.deepEqual(actions, [
    'pause',
    'resume',
    'cancel',
    'emergency_stop',
    'set_temperature',
  ])
  assert.ok(capabilityId)
  const result = await dispatcher.dispatch(
    await fixture.sign({ capability_id: capabilityId }, dispatcher.now()),
  )
  assert.equal(result.kind, 'applied')
  assert.equal(dispatcher.writes(), 1)
})

test('only advertised role-allowed actions are signed, with stable fallback for absent advertisements', async () => {
  const fixture = await createV2Authority(await nodeSigner())
  const dispatcher = await openV2Dispatch(fixture, {
    now: 2000,
    async capabilityWire(claims) {
      const modern = await issue(fixture, claims, [
        'set_tool_temperature',
        'power',
        'future_action',
      ])
      assert.ok(modern.ok)
      assert.deepEqual(modern.capability.actions, ['set_tool_temperature'])
      const empty = await issue(fixture, claims, ['power', 'future_action'])
      assert.deepEqual(empty, { ok: false, reason: 'denied' })
      const missing = await issue(fixture, claims, undefined)
      assert.ok(missing.ok)
      assert.deepEqual(previousActionList.parse(missing.capability.actions), [
        'pause',
        'resume',
        'cancel',
        'emergency_stop',
      ])
      return encodePauseCapability(missing.capability)
    },
  })
  dispatcher.close()
})
