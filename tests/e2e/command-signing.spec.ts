import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createV2Authority,
  openV2Dispatch,
  rejected,
  type V2Dispatch,
} from '../helpers/command-v2-dispatch.ts'
import { chromiumSigner } from '../helpers/browser-v2-signer.ts'

// Bundle the actual protocol implementation for Chromium, with no remote imports.
test('Chromium persisted nonextractable key survives reload and signs a v2 command applied once by the Connector', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'open3d-browser-sign-'))
  const outfile = join(directory, 'protocol.js')
  let harness: V2Dispatch | undefined
  try {
    buildSync({
      entryPoints: ['./tests/helpers/browser-device-entry.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      outfile,
      logLevel: 'silent',
    })
    await page.goto('/')
    const id = '00000000-0000-4000-8000-000000000001'
    const source = readFileSync(outfile, 'utf8')
    const initial = await chromiumSigner(page, source, {
      farmId: id,
      userId: id,
    })
    await page.reload()
    const signer = await chromiumSigner(page, source, {
      farmId: id,
      userId: id,
    })
    expect(signer.publicJwk).toEqual(initial.publicJwk)
    expect(signer.exportDenied).toBe(true)
    const authority = await createV2Authority(signer)
    harness = await openV2Dispatch(authority, {
      directory: join(directory, 'state'),
    })
    const wire = await authority.sign()
    expect((await harness.dispatch(wire)).kind).toBe('applied')
    expect(await harness.dispatch(wire)).toEqual(rejected('replay'))
    expect(harness.claims()).toBe(1)
    expect(harness.writes()).toBe(1)
  } finally {
    harness?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
