import { test, expect } from 'bun:test'
import {
  createBrowserKey,
  signCommand,
  encodeCommand,
} from '@open3dfarmmanager/farm-protocol'
import {
  authorizeCommand,
  type CommandContext,
} from '../../packages/connector/src/auth/verify.ts'
const id = '00000000-0000-4000-8000-000000000001'
async function fixture() {
  const pair = await createBrowserKey()
  const command = await signCommand(
    {
      farm_id: id,
      agent_id: id,
      printer_id: id,
      user_id: id,
      key_id: id,
      session_id: id,
      action: 'pause',
    },
    pair.privateKey,
    1000,
  )
  const context: CommandContext = {
    farmId: id,
    agentId: id,
    userId: id,
    keyId: id,
    sessionId: id,
    printerIds: new Set([id]),
    now: 1000,
    authorization: { issuedAt: 1000, expiresAt: 61000 },
    key: {
      id,
      farmId: id,
      userId: id,
      role: 'operator',
      revokedAt: null,
      publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    },
  }
  return { wire: encodeCommand(command), context }
}

test('incomplete runtime authorization contexts return denial without throwing or claiming', async () => {
  const { wire, context } = await fixture()
  let claims = 0
  const replay = {
    claim() {
      claims++
      return 'accepted' as const
    },
  }
  for (const invalid of [
    null,
    undefined,
    {},
    { ...context, key: undefined },
    { ...context, authorization: null },
    { ...context, printerIds: [] },
    { ...context, key: { ...context.key, id: undefined } },
  ]) {
    expect(authorizeCommand(wire, invalid as CommandContext, replay)).toEqual({
      ok: false,
      reason: 'invalid-context',
    })
  }
  expect(claims).toBe(0)
})
test('unexpected storage responses never escape as protocol reasons', async () => {
  const { wire, context } = await fixture()
  for (const result of [
    'INTERNAL_PRIVATE_MARKER',
    { detail: 'INTERNAL_PRIVATE_MARKER' },
    null,
    undefined,
    true,
  ]) {
    expect(
      authorizeCommand(wire, context, {
        claim() {
          return result as never
        },
      }),
    ).toEqual({ ok: false, reason: 'storage-unavailable' })
  }
})
test('all documented storage denials stay denials and each makes only one claim attempt', async () => {
  const { wire, context } = await fixture()
  for (const reason of [
    'replay',
    'capacity',
    'clock-regressed',
    'rate-limited',
  ] as const) {
    let claims = 0
    expect(
      authorizeCommand(wire, context, {
        claim() {
          claims++
          return reason
        },
      }),
    ).toEqual({ ok: false, reason })
    expect(claims).toBe(1)
  }
})
test('malformed command frames do not reach replay storage', async () => {
  const { wire, context } = await fixture()
  let claims = 0
  for (const frame of [
    'null',
    '[]',
    '{',
    ' '.repeat(8193),
    wire.replace('"v":1', '"v":1,"v":1'),
    wire.replace('"pause"', '"arbitrary-gcode"'),
  ]) {
    expect(
      authorizeCommand(frame, context, {
        claim() {
          claims++
          return 'accepted'
        },
      }),
    ).toEqual({ ok: false, reason: 'invalid-command' })
  }
  expect(claims).toBe(0)
})
