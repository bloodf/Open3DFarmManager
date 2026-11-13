import { expect, it } from 'vitest'
import { BrowserDeviceUuid } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { PauseCapabilityV1 } from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  configurationPayload,
  CONFIGURATION_DOMAINS,
} from '../../packages/farm-protocol/src/configuration-common.ts'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import {
  deriveConfigurationAssignmentIdentity,
  signConfigurationInventoryAck,
  verifyConfigurationInventoryAck,
  encodeConfigurationInventoryAck,
  decodeConfigurationInventoryAck,
  ConfigurationInventoryExpectation,
} from '../../packages/farm-protocol/src/configuration-inventory.ts'

const uuid = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const digest = 'A'.repeat(43)
const stable = {
  account_id: 'owner',
  farm_id: uuid,
  agent_id: uuid,
  bridge_instance_id: 'bridge-1',
  device_id: 'device-1',
}
async function fixture() {
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const identity = await deriveConfigurationAssignmentIdentity(stable)
  const claims = {
    v: 1,
    protocol: 'config-v1',
    purpose: 'configuration-inventory-ack',
    context: {
      account_id: 'owner',
      farm_id: uuid,
      agent_id: uuid,
      key_id: uuid,
      transport_id: uuid,
      browser_thumbprint: digest,
      connector_fingerprint: 'SHA256:' + digest,
      credential_jti: uuid,
      configuration_binding_sha256: digest,
      origin: 'https://farm.example',
      audience: 'https://farm.example',
    },
    kid: 'issuer-1',
    issuer: 'https://farm.example',
    operation_id: uuid,
    committed_receipt_sha256: digest,
    committed_revision: 1,
    ...identity,
    nonce: digest,
    issued_at: 1000,
    expires_at: 31000,
  }
  const { v, protocol, purpose, nonce, issued_at, expires_at, ...expected } =
    claims
  return {
    keys,
    claims,
    expected: ConfigurationInventoryExpectation.parse(expected),
    ack: await signConfigurationInventoryAck(claims, keys.privateKey),
  }
}
it('derives stable domain-scoped identity accepted by existing validators', async () => {
  const id = await deriveConfigurationAssignmentIdentity(stable)
  expect(await deriveConfigurationAssignmentIdentity({ ...stable })).toEqual(id)
  expect(BrowserDeviceUuid.safeParse(id.assignment_id).success).toBe(true)
  expect(
    PauseCapabilityV1.shape.printer_key.safeParse(id.printer_key).success,
  ).toBe(true)
  for (const field of Object.keys(stable)) {
    const value =
      field.endsWith('_id') && ['farm_id', 'agent_id'].includes(field)
        ? other
        : 'different'
    expect(
      await deriveConfigurationAssignmentIdentity({
        ...stable,
        [field]: value,
      }),
    ).not.toEqual(id)
  }
  for (const extra of [
    'operation_id',
    'transport_id',
    'credential_jti',
    'nonce',
  ]) {
    await expect(
      deriveConfigurationAssignmentIdentity({ ...stable, [extra]: uuid }),
    ).rejects.toThrow()
  }
  await expect(
    deriveConfigurationAssignmentIdentity({
      ...stable,
      device_id: 'https://secret',
    }),
  ).rejects.toThrow()
})
it('round trips and requires exact trusted expectations and current time', async () => {
  const { ack, keys, expected, claims } = await fixture()
  expect(
    decodeConfigurationInventoryAck(encodeConfigurationInventoryAck(ack)),
  ).toEqual(ack)
  expect(
    await verifyConfigurationInventoryAck(ack, keys.publicKey, expected, 1000),
  ).toBe(true)
  for (const now of [999, 31000, 32000, NaN])
    expect(
      await verifyConfigurationInventoryAck(ack, keys.publicKey, expected, now),
    ).toBe(false)
  for (const [field, value] of Object.entries(expected)) {
    if (field === 'context') continue
    expect(
      await verifyConfigurationInventoryAck(
        ack,
        keys.publicKey,
        { ...expected, [field]: typeof value === 'number' ? 2 : 'wrong' },
        1000,
      ),
    ).toBe(false)
  }
  for (const field of Object.keys(expected.context)) {
    expect(
      await verifyConfigurationInventoryAck(
        ack,
        keys.publicKey,
        {
          ...expected,
          context: {
            ...expected.context,
            [field]:
              field.endsWith('_id') || field === 'credential_jti'
                ? other
                : 'wrong',
          },
        },
        1000,
      ),
    ).toBe(false)
  }
  const fresh = {
    ...claims,
    context: { ...claims.context, transport_id: other, credential_jti: other },
  }
  const freshAck = await signConfigurationInventoryAck(fresh, keys.privateKey)
  const freshExpected = { ...expected, context: fresh.context }
  expect(
    await verifyConfigurationInventoryAck(
      freshAck,
      keys.publicKey,
      freshExpected,
      1000,
    ),
  ).toBe(true)
  expect(
    await verifyConfigurationInventoryAck(
      ack,
      keys.publicKey,
      freshExpected,
      1000,
    ),
  ).toBe(false)
  expect(freshAck.assignment_id).toBe(ack.assignment_id)
})
it('rejects tamper, wrong key, foreign purpose signatures and malformed wire', async () => {
  const { ack, keys, claims, expected } = await fixture()
  const wrong = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  expect(
    await verifyConfigurationInventoryAck(ack, wrong.publicKey, expected, 1000),
  ).toBe(false)
  expect(
    await verifyConfigurationInventoryAck(
      { ...ack, nonce: 'B' + digest.slice(1) },
      keys.publicKey,
      expected,
      1000,
    ),
  ).toBe(false)
  for (const domain of [
    CONFIGURATION_DOMAINS.capability,
    CONFIGURATION_DOMAINS.receipt,
  ]) {
    const signature = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          keys.privateKey,
          configurationPayload(domain, canonicalize(claims)),
        ),
      ),
    )
    expect(
      await verifyConfigurationInventoryAck(
        { ...ack, signature },
        keys.publicKey,
        expected,
        1000,
      ),
    ).toBe(false)
  }
  for (const patch of [
    { expires_at: 31001 },
    { expires_at: 1000 },
    { issued_at: -1 },
    { secret: 'x' },
    { context: { ...claims.context, url: 'http://127.0.0.1' } },
    { committed_revision: '1' },
    { purpose: 'configuration-receipt' },
  ]) {
    await expect(
      signConfigurationInventoryAck({ ...claims, ...patch }, keys.privateKey),
    ).rejects.toThrow()
  }
  for (const wire of [
    ' '.repeat(8193),
    '{"x":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}',
    JSON.stringify({ ...ack, extra: true }),
    '{}',
    'null',
  ]) {
    expect(() => decodeConfigurationInventoryAck(wire)).toThrow()
  }
})
