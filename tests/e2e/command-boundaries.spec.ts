// v2 command path (#609): Chromium signs with its persisted device key; the
// Connector's capability admission, verifyCommandV2 and durable journal decide.
import { test, expect, type Page } from '@playwright/test'
import { buildSync } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  createV2Authority,
  openV2Dispatch,
  rejected,
  type V2Authority,
  type V2Dispatch,
} from '../helpers/command-v2-dispatch.ts'
import { chromiumSigner } from '../helpers/browser-v2-signer.ts'

const id = '00000000-0000-4000-8000-000000000001'
let directory: string
let source: string
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'open3d-browser-boundaries-'))
  const outfile = join(directory, 'browser.js')
  buildSync({
    entryPoints: ['./tests/helpers/browser-device-entry.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  source = readFileSync(outfile, 'utf8')
})
test.afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

async function chromiumAuthority(page: Page): Promise<V2Authority> {
  await page.goto('/')
  return createV2Authority(
    await chromiumSigner(page, source, { farmId: id, userId: id }),
  )
}

test('Chromium signatures cannot bypass scope, revocation, roles or the capability deadline', async ({
  page,
}) => {
  const authority = await chromiumAuthority(page)
  const harnesses: V2Dispatch[] = []
  const open = async (options: Parameters<typeof openV2Dispatch>[1] = {}) => {
    const harness = await openV2Dispatch(authority, options)
    harnesses.push(harness)
    return harness
  }
  try {
    const harness = await open()
    // Scope: v1 farm/agent/user/session/key/printer map to the capability's
    // farm, agent, account, transport, key, assignment and capability IDs.
    for (const [field, value] of [
      ['farm_id', randomUUID()],
      ['agent_id', randomUUID()],
      ['account_id', 'other_account'],
      ['transport_id', randomUUID()],
      ['key_id', randomUUID()],
      ['assignment_id', randomUUID()],
      ['capability_id', randomUUID()],
    ] as const)
      expect(
        await harness.dispatch(await authority.sign({ [field]: value })),
      ).toEqual(rejected('scope'))
    // Unknown printer: a binding outside the admitted assignment.
    const other = createPrinterBindingRegistry({
      allowedOrigins: ['http://127.0.0.1:7125'],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: authority.ids.farm_id,
      agent_id: authority.ids.agent_id,
      printer_key: 'printer-2',
      moonraker_origin: 'http://127.0.0.1:7125',
    })
    expect(
      await harness.dispatcher.dispatch({
        wire: await authority.sign(),
        capability: harness.handle,
        printerBinding: other,
      }),
    ).toEqual(rejected('scope'))
    // Role: the capability grants only pause; viewer cannot hold a capability.
    expect(
      await harness.dispatch(
        await authority.sign({
          action: 'emergency_stop',
          purpose: 'printer-control',
        }),
      ),
    ).toEqual(rejected('scope'))
    await expect(
      openV2Dispatch(authority, {
        capability: { role: 'viewer' as 'operator' },
      }),
    ).rejects.toThrow()
    // Oversized capability lifetime is refused at admission.
    await expect(
      openV2Dispatch(authority, { capability: { expires_at: 999_999 } }),
    ).rejects.toThrow()
    // Expired command.
    const expired = await open()
    const stale = await authority.sign()
    expired.advance(5000)
    expect(await expired.dispatch(stale)).toEqual(rejected('expired'))
    // Expired capability.
    const lapsed = await open({ capability: { expires_at: 7000 } })
    lapsed.advance(6000)
    const late = await authority.sign({}, 6900)
    expect(await lapsed.dispatch(late)).toEqual(rejected('invalid-authority'))
    // Revoked capability.
    const revoked = await open()
    revoked.revoke()
    expect(await revoked.dispatch(await authority.sign())).toEqual(
      rejected('invalid-authority'),
    )
    for (const each of harnesses) expect(each.claims()).toBe(0)
    // Rejections must not consume the valid command ID or nonce.
    expect((await harness.dispatch(await authority.sign())).kind).toBe(
      'applied',
    )
    expect(harness.claims()).toBe(1)
  } finally {
    for (const harness of harnesses) harness.close()
  }
})

test('tampered or ambiguous Chromium commands never reach the journal; valid replay stays rejected after reopen', async ({
  page,
}) => {
  const authority = await chromiumAuthority(page)
  const path = join(directory, 'tamper-journal')
  let harness = await openV2Dispatch(authority, {
    directory: path,
    capability: { actions: ['pause', 'resume'] },
  })
  try {
    const wire = await authority.sign({}, 1050)
    const command = decodeCommandV2(wire)
    const changedAction = encodeCommandV2({
      ...command,
      action: 'resume',
      purpose: 'printer-control',
    })
    const changedId = encodeCommandV2({ ...command, cmd_id: randomUUID() })
    harness.advance(60)
    for (const tampered of [changedAction, changedId])
      expect(await harness.dispatch(tampered)).toEqual(rejected('signature'))
    for (const malformed of [
      wire + ' ',
      wire.replace('"action":', '"action":"pause","action":'),
      '{',
      'x'.repeat(8193),
    ])
      expect(await harness.dispatch(malformed)).toEqual(
        rejected('invalid-command'),
      )
    expect(harness.claims()).toBe(0)
    expect((await harness.dispatch(wire)).kind).toBe('applied')
    harness.close()
    harness = await openV2Dispatch(authority, { directory: path, now: 1050 })
    harness.advance(100)
    expect(await harness.dispatch(wire)).toEqual(rejected('replay'))
    expect(harness.claims()).toBe(1)
  } finally {
    harness.close()
  }
})

test('a closed journal denies even a valid Chromium emergency-stop signature', async ({
  page,
}) => {
  const authority = await chromiumAuthority(page)
  const path = join(directory, 'unavailable-journal')
  const options = {
    directory: path,
    controls: ['pause', 'emergency_stop'] as ('pause' | 'emergency_stop')[],
    capability: {
      actions: ['pause', 'emergency_stop'] as ('pause' | 'emergency_stop')[],
    },
  }
  let harness = await openV2Dispatch(authority, options)
  try {
    const wire = await authority.sign(
      { action: 'emergency_stop', purpose: 'printer-control' },
      1050,
    )
    harness.advance(60)
    harness.closeJournal()
    expect(await harness.dispatch(wire)).toEqual(rejected('storage'))
    expect(harness.writes()).toBe(0)
    harness.close()
    harness = await openV2Dispatch(authority, { ...options, now: 1050 })
    harness.advance(10)
    expect(harness.claims()).toBe(0)
    const result = await harness.dispatch(wire)
    expect(result.kind).not.toBe('rejected')
    expect(harness.claims()).toBe(1)
    expect(harness.writes()).toBe(1)
  } finally {
    harness.close()
  }
})
