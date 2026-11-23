import { expect, it } from 'vitest'
import { BrowserDeviceUuid } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { PauseCapabilityV1 } from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
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
  ConfigurationPrinterKey,
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
it('derives the printer key prefix from the configured backend bridge', async () => {
  const keyFor = async (bridge_instance_id: string) =>
    (
      await deriveConfigurationAssignmentIdentity({
        ...stable,
        bridge_instance_id,
      })
    ).printer_key
  const cases = [
    ['moonraker-bridge', 'moonraker-'],
    ['bambu-bridge', 'bambu-'],
    ['kobra-x-bridge', 'kobra-x-'],
  ] as const
  for (const [bridge, prefix] of cases) {
    const key = await keyFor(bridge)
    expect(key.startsWith(prefix)).toBe(true)
    expect(ConfigurationPrinterKey.safeParse(key).success).toBe(true)
    expect(PauseCapabilityV1.shape.printer_key.safeParse(key).success).toBe(
      true,
    )
  }
  expect(ConfigurationPrinterKey.safeParse('journey-bambu').success).toBe(false)
})
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
  for (const now of [999, 903, 1000 - CONFIGURATION_HARD_MAXIMUMS.skewMs])
    expect(
      await verifyConfigurationInventoryAck(ack, keys.publicKey, expected, now),
    ).toBe(true)
  for (const now of [
    1000 - CONFIGURATION_HARD_MAXIMUMS.skewMs - 1,
    31000,
    32000,
    NaN,
  ])
    expect(
      await verifyConfigurationInventoryAck(ack, keys.publicKey, expected, now),
    ).toBe(false)
  for (const [field, value] of Object.entries(expected)) {
    if (field === 'context') continue
    const replacement =
      typeof value === 'number'
        ? field === 'expires_at'
          ? value - 1
          : value + 1
        : BrowserDeviceUuid.safeParse(value).success
          ? other
          : field.includes('sha256')
            ? 'C'.repeat(42) + 'A'
            : field === 'printer_key'
              ? String(value).match(/^(?:kobra-x|moonraker|bambu)-/)![0] +
                'B'.repeat(42) +
                'A'
              : 'different-' + String(value)
    expect(
      ConfigurationInventoryExpectation.safeParse({
        ...expected,
        [field]: replacement,
      }).success,
      field,
    ).toBe(true)
    expect(
      await verifyConfigurationInventoryAck(
        ack,
        keys.publicKey,
        { ...expected, [field]: replacement },
        1000,
      ),
    ).toBe(false)
  }
  for (const field of Object.keys(expected.context)) {
    const current = expected.context[field as keyof typeof expected.context]
    const replacement =
      typeof current === 'string' && current.startsWith('SHA256:')
        ? 'SHA256:' + 'C'.repeat(42) + 'A'
        : field.includes('_id') || field === 'credential_jti'
          ? other
          : field.includes('sha256') || field.includes('thumbprint')
            ? 'C'.repeat(42) + 'A'
            : 'https://other.example'
    expect(
      ConfigurationInventoryExpectation.safeParse({
        ...expected,
        context: { ...expected.context, [field]: replacement },
      }).success,
      field,
    ).toBe(true)
    expect(
      await verifyConfigurationInventoryAck(
        ack,
        keys.publicKey,
        {
          ...expected,
          context: {
            ...expected.context,
            [field]: replacement,
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
