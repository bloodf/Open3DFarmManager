import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeCommand } from '../../packages/connector/src/auth/verify.ts'
import { PersistentReplayStore } from '../../packages/connector/src/auth/replay.ts'

// Bundle the actual protocol implementation for Chromium, with no remote imports.
test('Chromium nonextractable key produces a command accepted once by Node', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-browser-sign-'))
  const outfile = join(directory, 'protocol.js')
  let store: PersistentReplayStore | undefined
  try {
    execFileSync('bun', [
      'build',
      './packages/farm-protocol/src/index.ts',
      '--target=browser',
      '--outfile',
      outfile,
    ])
    await page.goto('/')
    const id = '00000000-0000-4000-8000-000000000001'
    const now = Date.now()
    const signed = await page.evaluate(
      async ({ source, id, now }) => {
        const url = URL.createObjectURL(
          new Blob([source], { type: 'text/javascript' }),
        )
        try {
          const protocol = await import(url)
          const pair = await protocol.createBrowserKey()
          let exportDenied = false
          try {
            await crypto.subtle.exportKey('jwk', pair.privateKey)
          } catch {
            exportDenied = true
          }
          const command = await protocol.signCommand(
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
            now,
          )
          return {
            wire: protocol.encodeCommand(command) as string,
            publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
            exportDenied,
          }
        } finally {
          URL.revokeObjectURL(url)
        }
      },
      { source: readFileSync(outfile, 'utf8'), id, now },
    )
    expect(signed.exportDenied).toBe(true)
    const context = {
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
        role: 'operator' as const,
        revokedAt: null,
        publicJwk: signed.publicJwk,
      },
    }
    store = new PersistentReplayStore(join(directory, 'state'))
    expect(authorizeCommand(signed.wire, context, store).ok).toBe(true)
    expect(authorizeCommand(signed.wire, context, store)).toEqual({
      ok: false,
      reason: 'replay',
    })
  } finally {
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
