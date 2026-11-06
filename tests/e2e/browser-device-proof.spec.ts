import { expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browserDeviceProofPayload,
  validateBrowserDevicePublicKey,
  verifyBrowserDeviceProof,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'

let bundleDirectory: string | undefined
let browserBundle: string

test.beforeAll(async () => {
  bundleDirectory = await mkdtemp(join(tmpdir(), 'open3dfarm-browser-proof-'))
  const outfile = join(bundleDirectory, 'browser-device-proof.js')
  buildSync({
    entryPoints: [
      fileURLToPath(
        new URL(
          '../../packages/farm-protocol/src/browser-device-proof.ts',
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  browserBundle = await readFile(outfile, 'utf8')
})

test.afterAll(async () => {
  if (bundleDirectory)
    await rm(bundleDirectory, { recursive: true, force: true })
})

test('bundled browser protocol validates keys and signs canonical proofs verified by the server', async ({
  page,
}) => {
  await page.route('https://farm.example/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: route.request().url().endsWith('/browser-device-proof.js')
        ? 'text/javascript'
        : 'text/html',
      body: route.request().url().endsWith('/browser-device-proof.js')
        ? browserBundle
        : '<!doctype html><title>Bundled proof fixture</title>',
    }),
  )
  await page.goto('https://farm.example/')
  const result = await page.evaluate(async () => {
    const moduleUrl = '/browser-device-proof.js'
    const protocol: typeof import('../../packages/farm-protocol/src/browser-device-proof.ts') =
      await import(moduleUrl)
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )
    const binding = await protocol.validateBrowserDevicePublicKey({
      kty,
      crv,
      x,
      y,
    })
    const challenge = protocol.BrowserDeviceProofChallenge.parse({
      v: 1,
      purpose: 'enroll',
      challenge_id: crypto.randomUUID(),
      farm_id: crypto.randomUUID(),
      key_id: crypto.randomUUID(),
      account_id: 'legacy_account',
      session_id: crypto.randomUUID(),
      thumbprint: binding.thumbprint,
      origin: location.origin,
      audience: 'open3dfarmmanager:browser-device',
      nonce: 'A'.repeat(43),
      issued_at: 100,
      expires_at: 60100,
    })
    let privateExportDenied = false
    try {
      await crypto.subtle.exportKey('jwk', pair.privateKey)
    } catch {
      privateExportDenied = true
    }
    let invalidPointDenied = false
    try {
      await protocol.validateBrowserDevicePublicKey({
        ...binding.publicKey,
        x: 'A'.repeat(43),
        y: 'A'.repeat(43),
      })
    } catch {
      invalidPointDenied = true
    }
    const signature = await protocol.signBrowserDeviceProof(
      challenge,
      pair.privateKey,
    )
    const tampered = { ...challenge, purpose: 'recover' }
    return {
      ...binding,
      challenge,
      signature,
      privateExportDenied,
      invalidPointDenied,
      payload: Array.from(protocol.browserDeviceProofPayload(challenge)),
      browserVerified: await protocol.verifyBrowserDeviceProof(
        challenge,
        binding.publicKey,
        signature,
      ),
      browserTamperVerified: await protocol.verifyBrowserDeviceProof(
        tampered,
        binding.publicKey,
        signature,
      ),
    }
  })
  expect(result.privateExportDenied).toBe(true)
  expect(result.invalidPointDenied).toBe(true)
  expect(result.browserVerified).toBe(true)
  expect(result.browserTamperVerified).toBe(false)
  expect(result.payload).toEqual(
    Array.from(browserDeviceProofPayload(result.challenge)),
  )
  expect(new TextDecoder().decode(new Uint8Array(result.payload))).toMatch(
    /^Open3DFarmManager\/browser-device-proof\/v1\0\{/,
  )
  expect(await validateBrowserDevicePublicKey(result.publicKey)).toEqual({
    publicKey: result.publicKey,
    thumbprint: result.thumbprint,
  })
  expect(
    await verifyBrowserDeviceProof(
      result.challenge,
      result.publicKey,
      result.signature,
    ),
  ).toBe(true)
  expect(
    await verifyBrowserDeviceProof(
      { ...result.challenge, purpose: 'recover' },
      result.publicKey,
      result.signature,
    ),
  ).toBe(false)
})
