import { test, expect, type Page } from '@playwright/test'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeCommand, decodeCommand } from '@open3dfarmmanager/farm-protocol'
import {
  authorizeCommand,
  type CommandContext,
  type CommandRejectionReason,
} from '../../packages/connector/src/auth/verify.ts'
import { PersistentReplayStore } from '../../packages/connector/src/auth/replay.ts'

const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
let directory: string
let source: string
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'open3d-browser-boundaries-'))
  const outfile = join(directory, 'browser.js')
  buildSync({
    entryPoints: ['./tests/helpers/browser-device-entry.ts'],
    bundle: true,
    target: 'browser',
    outfile,
    logLevel: 'silent',
  })
  source = readFileSync(outfile, 'utf8')
})
test.afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

async function fixture(page: Page) {
  await page.goto('/')
  const now = Date.now()
  const signed = await page.evaluate(
    async ({ source, id, now }) => {
      const url = URL.createObjectURL(
        new Blob([source], { type: 'text/javascript' }),
      )
      try {
        const api = await import(url)
        const pair = await api.loadOrCreateDeviceKey({ farmId: id, userId: id })
        const commands: string[] = []
        for (const action of ['pause', 'emergency_stop'])
          commands.push(
            api.encodeCommand(
              await api.signCommand(
                {
                  farm_id: id,
                  agent_id: id,
                  printer_id: id,
                  user_id: id,
                  key_id: id,
                  session_id: id,
                  action,
                },
                pair.privateKey,
                now,
              ),
            ),
          )
        return {
          commands,
          publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
        }
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    { source, id, now },
  )
  const context: CommandContext = {
    farmId: id,
    agentId: id,
    userId: id,
    keyId: id,
    sessionId: id,
    printerIds: new Set([id]),
    now,
    authorization: { issuedAt: now, expiresAt: now + 60_000 },
    key: {
      id,
      farmId: id,
      userId: id,
      role: 'operator',
      revokedAt: null,
      publicJwk: signed.publicJwk,
    },
  }
  return { ...signed, context }
}

test('Chromium signatures cannot bypass scope, revocation, roles or the prototype authorization deadline', async ({
  page,
}) => {
  const { commands, context } = await fixture(page)
  const store = new PersistentReplayStore(join(directory, 'context-store'))
  let claims = 0
  const tracked = {
    claim: (...args: Parameters<typeof store.claim>) => {
      claims++
      return store.claim(...args)
    },
  }
  try {
    const cases: Array<[CommandContext, CommandRejectionReason]> = [
      [
        { ...context, farmId: other, key: { ...context.key, farmId: other } },
        'scope-mismatch',
      ],
      [{ ...context, agentId: other }, 'scope-mismatch'],
      [
        { ...context, userId: other, key: { ...context.key, userId: other } },
        'scope-mismatch',
      ],
      [{ ...context, sessionId: other }, 'scope-mismatch'],
      [
        { ...context, keyId: other, key: { ...context.key, id: other } },
        'scope-mismatch',
      ],
      [{ ...context, printerIds: new Set([other]) }, 'unknown-printer'],
      [
        { ...context, key: { ...context.key, revokedAt: context.now } },
        'revoked-key',
      ],
      [{ ...context, key: { ...context.key, role: 'viewer' } }, 'role-denied'],
      [
        {
          ...context,
          authorization: {
            issuedAt: context.now - 1000,
            expiresAt: context.now,
          },
        },
        'authorization-expired',
      ],
      [
        {
          ...context,
          authorization: {
            issuedAt: context.now,
            expiresAt: context.now + 60_001,
          },
        },
        'invalid-authorization',
      ],
      [
        {
          ...context,
          now: context.now + 60_000,
          authorization: {
            issuedAt: context.now + 60_000,
            expiresAt: context.now + 120_000,
          },
        },
        'command-expired',
      ],
    ]
    for (const wire of commands)
      for (const [candidate, reason] of cases)
        expect(authorizeCommand(wire, candidate, tracked)).toEqual({
          ok: false,
          reason,
        })
    expect(claims).toBe(0)
    // Rejections must not consume the valid command ID or nonce.
    expect(authorizeCommand(commands[0]!, context, tracked).ok).toBe(true)
    expect(claims).toBe(1)
  } finally {
    store.close()
  }
})

test('tampered or ambiguous Chromium commands never claim replay storage; valid replay stays rejected after reopen', async ({
  page,
}) => {
  const { commands, context } = await fixture(page)
  const path = join(directory, 'tamper-store')
  let store = new PersistentReplayStore(path)
  let claims = 0
  const tracked = {
    claim: (...args: Parameters<typeof store.claim>) => {
      claims++
      return store.claim(...args)
    },
  }
  try {
    const wire = commands[0]!
    const command = decodeCommand(wire)
    const changedAction = encodeCommand({ ...command, action: 'resume' })
    const changedId = encodeCommand({ ...command, cmd_id: other })
    for (const tampered of [changedAction, changedId])
      expect(authorizeCommand(tampered, context, tracked)).toEqual({
        ok: false,
        reason: 'invalid-signature',
      })
    for (const malformed of [
      wire + ' ',
      wire.replace('"action":', '"action":"pause","action":'),
      '{',
      'x'.repeat(8193),
    ])
      expect(authorizeCommand(malformed, context, tracked)).toEqual({
        ok: false,
        reason: 'invalid-command',
      })
    expect(claims).toBe(0)
    expect(authorizeCommand(wire, context, tracked).ok).toBe(true)
    store.close()
    store = new PersistentReplayStore(path)
    expect(authorizeCommand(wire, context, store)).toEqual({
      ok: false,
      reason: 'replay',
    })
  } finally {
    store.close()
  }
})

test('closed persistent storage denies even a valid Chromium emergency-stop signature', async ({
  page,
}) => {
  const { commands, context } = await fixture(page)
  const path = join(directory, 'unavailable-store')
  let store = new PersistentReplayStore(path)
  store.close()
  try {
    expect(authorizeCommand(commands[1]!, context, store)).toEqual({
      ok: false,
      reason: 'storage-unavailable',
    })
    store = new PersistentReplayStore(path)
    expect(authorizeCommand(commands[1]!, context, store).ok).toBe(true)
  } finally {
    store.close()
  }
})
