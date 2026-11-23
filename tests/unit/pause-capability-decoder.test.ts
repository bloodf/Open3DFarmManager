import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import {
  decodePauseCapability,
  verifyPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  createV2Authority,
  nodeSigner,
} from '../helpers/command-v2-dispatch.ts'

test('a future action survives decoding and is required by the issuer signature', async () => {
  const { binding, issuer, printerKey } = await createV2Authority(
    await nodeSigner(),
  )
  const claims = {
    v: 1,
    purpose: 'pause-authority',
    capability_id: randomUUID(),
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: binding.issued_at,
    expires_at: binding.expires_at,
    account_id: binding.account_id,
    role: 'operator',
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: binding.browser_public_key,
    browser_thumbprint: binding.browser_thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: printerKey,
    control_binding_sha256: binding.offer_sha256,
    admission_nonce: binding.browser_nonce,
    actions: ['pause', 'future_action', 'resume'],
  }
  const payload = Buffer.from(
    'Open3DFarmManager/pause-capability/v1\0' + canonicalize(claims),
  )
  const signature = Buffer.from(
    await crypto.subtle.sign('Ed25519', issuer.privateKey, payload),
  ).toString('base64url')

  const decoded = decodePauseCapability(canonicalize({ ...claims, signature }))
  expect(decoded.actions).toEqual(['pause', 'future_action', 'resume'])
  await expect(verifyPauseCapability(decoded, issuer.publicKey)).resolves.toBe(
    true,
  )
  await expect(
    verifyPauseCapability(
      { ...decoded, actions: ['pause', 'resume'] },
      issuer.publicKey,
    ),
  ).resolves.toBe(false)
})
