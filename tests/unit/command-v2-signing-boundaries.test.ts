import { expect, test } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  decodeCommandV2,
  encodeCommandV2,
  signCommandV2,
  verifyCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'

async function fixture() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const publicKey = { kty, crv, x, y }
  const input = {
    v: 2 as const,
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: 1000,
    expires_at: 6000,
    nonce: randomBytes(16).toString('base64url'),
  }
  const command = await signCommandV2(input, pair.privateKey)
  return { pair, publicKey, command, input }
}

test('nonextractable browser key signs a v2 command verified by the Connector', async () => {
  const f = await fixture()
  await expect(
    crypto.subtle.exportKey('jwk', f.pair.privateKey),
  ).rejects.toThrow()
  expect(
    await verifyCommandV2(
      decodeCommandV2(encodeCommandV2(f.command)),
      f.publicKey,
    ),
  ).toBe(true)
})

test('nonces and command IDs differ for repeated actions', async () => {
  const f = await fixture()
  const next = await signCommandV2(
    {
      ...f.input,
      cmd_id: randomUUID(),
      nonce: randomBytes(16).toString('base64url'),
    },
    f.pair.privateKey,
  )
  expect(next.nonce).not.toBe(f.command.nonce)
  expect(next.cmd_id).not.toBe(f.command.cmd_id)
})

test.each([
  'farm_id',
  'agent_id',
  'account_id',
  'key_id',
  'transport_id',
  'capability_id',
  'assignment_id',
  'cmd_id',
] as const)('reject substituted signed scope %s', async (field) => {
  const f = await fixture()
  expect(
    await verifyCommandV2({ ...f.command, [field]: randomUUID() }, f.publicKey),
  ).toBe(false)
})

test('changed action, wrong key and private JWK fail closed', async () => {
  const f = await fixture()
  expect(
    await verifyCommandV2(
      { ...f.command, action: 'cancel', purpose: 'printer-control' },
      f.publicKey,
    ),
  ).toBe(false)
  expect(
    await verifyCommandV2(f.command, { ...f.publicKey, d: 'A'.repeat(43) }),
  ).toBe(false)
  expect(await verifyCommandV2(f.command, (await fixture()).publicKey)).toBe(
    false,
  )
})

test('canonical wire rejects duplicate fields, whitespace and oversized frames', async () => {
  const f = await fixture()
  const wire = encodeCommandV2(f.command)
  expect(decodeCommandV2(wire)).toEqual(f.command)
  for (const value of [
    ' ' + wire,
    wire.replace('{', '{"v":2,'),
    'x'.repeat(8193),
  ])
    expect(() => decodeCommandV2(value)).toThrow()
})
