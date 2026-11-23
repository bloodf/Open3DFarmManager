// v2 command path (#609): signature (verifyCommandV2), capability admission
// and durable replay run through the shipped dispatcher with a fake driver.
import { afterEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  decodeCommandV2,
  encodeCommandV2,
  verifyCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  rejected,
  type V2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

const open: V2Dispatch[] = []
afterEach(() => {
  for (const harness of open.splice(0)) harness.close()
})
async function fixture(options: Parameters<typeof openV2Dispatch>[1] = {}) {
  const authority = await createV2Authority(await nodeSigner())
  const harness = await openV2Dispatch(authority, options)
  open.push(harness)
  return { authority, harness }
}

test('nonextractable browser key signs a command the Connector applies once', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  await expect(
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ).rejects.toThrow()
  const { authority, harness } = await fixture()
  const result = await harness.dispatch(await authority.sign())
  expect(result.kind).toBe('applied')
  expect(harness.claims()).toBe(1)
  expect(harness.writes()).toBe(1)
})

test('nonces and command IDs differ for repeated actions', async () => {
  const authority = await createV2Authority(await nodeSigner())
  const first = authority.command()
  const next = authority.command()
  expect(next.nonce).not.toBe(first.nonce)
  expect(next.cmd_id).not.toBe(first.cmd_id)
})

// v1 printer_id/user_id/session_id map to v2 assignment_id/account_id/transport_id.
test.each([
  'farm_id',
  'agent_id',
  'assignment_id',
  'account_id',
  'key_id',
  'transport_id',
  'capability_id',
] as const)(
  'reject re-signed substituted scope %s before persistence',
  async (field) => {
    const { authority, harness } = await fixture()
    const wire = await authority.sign({
      [field]: field === 'account_id' ? 'other_account' : randomUUID(),
    })
    expect(await harness.dispatch(wire)).toEqual(rejected('scope'))
    expect(harness.claims()).toBe(0)
    expect(harness.driverEntries()).toBe(0)
  },
)

test('reject changed action even when all scope IDs match', async () => {
  // The capability allows both actions, so only the signature can refuse it.
  const { authority, harness } = await fixture({
    capability: { actions: ['pause', 'resume'] },
  })
  const signed = decodeCommandV2(await authority.sign())
  const tampered = encodeCommandV2({
    ...signed,
    action: 'resume',
    purpose: 'printer-control',
  })
  expect(await harness.dispatch(tampered)).toEqual(rejected('signature'))
  expect(harness.claims()).toBe(0)
})

test('viewer role cannot hold a command capability', async () => {
  const authority = await createV2Authority(await nodeSigner())
  await expect(
    openV2Dispatch(authority, {
      capability: { role: 'viewer' as 'operator' },
    }),
  ).rejects.toThrow()
})

test('a private JWK is never accepted as the bound browser key', async () => {
  const signer = await nodeSigner()
  await expect(
    createV2Authority({
      ...signer,
      publicJwk: { ...signer.publicJwk, d: 'A'.repeat(43) } as never,
    }),
  ).rejects.toThrow()
  const command = decodeCommandV2(
    await (await createV2Authority(signer)).sign(),
  )
  expect(
    await verifyCommandV2(command, { ...signer.publicJwk, d: 'A'.repeat(43) }),
  ).toBe(false)
  expect(await verifyCommandV2(command, signer.publicJwk)).toBe(true)
})

test('capability lifetime beyond policy is refused at admission', async () => {
  const authority = await createV2Authority(await nodeSigner())
  await expect(
    openV2Dispatch(authority, { capability: { expires_at: 999_999 } }),
  ).rejects.toThrow()
})

test.each([
  'action-outside-capability',
  'revoked',
  'expired-capability',
  'expired-command',
  'future-command',
  'oversized-command-lifetime',
  'wrong-key',
  'storage-failure',
])('fail closed: %s', async (scenario) => {
  const { authority, harness } = await fixture()
  let wire = await authority.sign()
  let expected = rejected('signature')
  if (scenario === 'action-outside-capability') {
    wire = await authority.sign({
      action: 'cancel',
      purpose: 'printer-control',
    })
    expected = rejected('scope')
  }
  if (scenario === 'revoked') {
    harness.revoke()
    expected = rejected('invalid-authority')
  }
  if (scenario === 'expired-capability') {
    harness.advance(30_000)
    wire = await authority.sign({}, 31_000)
    expected = rejected('invalid-authority')
  }
  if (scenario === 'expired-command') {
    harness.advance(5000)
    expected = rejected('expired')
  }
  if (scenario === 'future-command') {
    wire = await authority.sign({}, 2001)
    expected = rejected('expired')
  }
  if (scenario === 'oversized-command-lifetime') {
    const signed = decodeCommandV2(wire)
    wire = JSON.stringify({ ...signed, expires_at: signed.issued_at + 5001 })
    expected = rejected('invalid-command')
  }
  if (scenario === 'wrong-key') {
    // The key bound by admission is the only key that can authorise.
    const other = await nodeSigner()
    wire = encodeCommandV2(await other.signCommand(authority.command()))
  }
  if (scenario === 'storage-failure') {
    harness.closeJournal()
    expected = rejected('storage')
  }
  const result = await harness.dispatch(wire)
  expect(result).toEqual(expected)
  if (scenario !== 'storage-failure') expect(harness.claims()).toBe(0)
  expect(harness.writes()).toBe(0)
})

test('canonical wire rejects duplicate fields, padding and oversized frames', async () => {
  const authority = await createV2Authority(await nodeSigner())
  const wire = await authority.sign()
  expect(encodeCommandV2(decodeCommandV2(wire))).toBe(wire)
  for (const value of [
    ' ' + wire,
    wire.replace('{', '{"v":2,'),
    'x'.repeat(8193),
  ])
    expect(() => decodeCommandV2(value)).toThrow()
})
