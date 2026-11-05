import { expect, test } from 'bun:test'
import {
  createBrowserKey,
  signCommand,
  encodeCommand,
  decodeCommand,
} from '@open3dfarmmanager/farm-protocol'
import { authorizeCommand } from '../../packages/connector/src/auth/verify.ts'
import type { CommandContext } from '../../packages/connector/src/auth/verify.ts'

const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const input = {
  farm_id: id,
  agent_id: id,
  printer_id: id,
  user_id: id,
  key_id: id,
  session_id: id,
  action: 'pause' as const,
}
async function fixture() {
  const pair = await createBrowserKey()
  const command = await signCommand(input, pair.privateKey, 100_000)
  const context: CommandContext = {
    farmId: id,
    agentId: id,
    userId: id,
    keyId: id,
    sessionId: id,
    printerIds: new Set([id]),
    now: 100_000,
    authorization: { issuedAt: 100_000, expiresAt: 160_000 },
    key: {
      id,
      farmId: id,
      userId: id,
      role: 'operator',
      revokedAt: null,
      publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    },
  }
  let claims = 0
  const replay = {
    claim() {
      claims++
      return 'accepted' as const
    },
  }
  return {
    pair,
    command,
    context,
    replay,
    get claims() {
      return claims
    },
  }
}
test('nonextractable browser key signs a command verified by Node crypto', async () => {
  const f = await fixture()
  await expect(
    crypto.subtle.exportKey('jwk', f.pair.privateKey),
  ).rejects.toThrow()
  expect(
    authorizeCommand(encodeCommand(f.command), f.context, f.replay).ok,
  ).toBe(true)
  expect(f.claims).toBe(1)
})
test('nonces and command IDs differ for repeated actions', async () => {
  const f = await fixture()
  const next = await signCommand(input, f.pair.privateKey, 100_000)
  expect(next.nonce).not.toBe(f.command.nonce)
  expect(next.cmd_id).not.toBe(f.command.cmd_id)
})
test.each([
  'farm_id',
  'agent_id',
  'printer_id',
  'user_id',
  'key_id',
  'session_id',
] as const)('reject substituted scope %s before persistence', async (field) => {
  const f = await fixture()
  const decision = authorizeCommand(
    encodeCommand({ ...f.command, [field]: other }),
    f.context,
    f.replay,
  )
  expect(decision.ok).toBe(false)
  expect(f.claims).toBe(0)
})
test('reject changed action even when all scope IDs match', async () => {
  const f = await fixture()
  expect(
    authorizeCommand(
      encodeCommand({ ...f.command, action: 'cancel' }),
      f.context,
      f.replay,
    ),
  ).toEqual({ ok: false, reason: 'invalid-signature' })
  expect(f.claims).toBe(0)
})
test.each([
  'viewer',
  'revoked',
  'expired-lease',
  'oversized-lease',
  'expired-command',
  'future-command',
  'private-jwk',
  'wrong-key',
  'storage-failure',
])('fail closed: %s', async (scenario) => {
  const f = await fixture()
  let command = f.command
  if (scenario === 'viewer') f.context.key.role = 'viewer'
  if (scenario === 'revoked') f.context.key.revokedAt = 1
  if (scenario === 'expired-lease') {
    f.context.now = 160_000
    command = await signCommand(input, f.pair.privateKey, 150_000)
  }
  if (scenario === 'oversized-lease')
    f.context.authorization.expiresAt = 999_999
  if (scenario === 'expired-command') {
    f.context.now = 160_000
    f.context.authorization = { issuedAt: 160_000, expiresAt: 220_000 }
  }
  if (scenario === 'future-command')
    command = await signCommand(input, f.pair.privateKey, 160_001)
  if (scenario === 'private-jwk')
    f.context.key.publicJwk = {
      ...(f.context.key.publicJwk as object),
      d: 'A'.repeat(43),
    }
  if (scenario === 'wrong-key')
    f.context.key.publicJwk = await crypto.subtle.exportKey(
      'jwk',
      (await createBrowserKey()).publicKey,
    )
  const replay =
    scenario === 'storage-failure'
      ? {
          claim() {
            throw new Error('disk full')
          },
        }
      : f.replay
  expect(authorizeCommand(encodeCommand(command), f.context, replay).ok).toBe(
    false,
  )
  expect(f.claims).toBe(0)
})
test('canonical wire rejects duplicate fields, padding and oversized frames', async () => {
  const f = await fixture()
  const wire = encodeCommand(f.command)
  expect(decodeCommand(wire)).toEqual(f.command)
  for (const value of [
    ' ' + wire,
    wire.replace('{', '{"v":1,'),
    'x'.repeat(8193),
  ])
    expect(() => decodeCommand(value)).toThrow()
})
