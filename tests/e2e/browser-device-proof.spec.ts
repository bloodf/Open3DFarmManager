import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  browserDeviceProofPayload,
  validateBrowserDevicePublicKey,
  verifyBrowserDeviceProof,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'

test('Chromium WebCrypto signs a proof verified by the server protocol', async ({
  page,
}) => {
  await page.route('https://farm.example/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Proof fixture</title>',
    }),
  )
  await page.goto('https://farm.example/')
  const jwk = await page.evaluate(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    Object.assign(globalThis, { browserProofPrivateKey: pair.privateKey })
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )
    return { kty, crv, x, y }
  })
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey(jwk)
  const challenge = {
    v: 1 as const,
    purpose: 'enroll' as const,
    challenge_id: randomUUID(),
    farm_id: randomUUID(),
    key_id: randomUUID(),
    account_id: 'legacy_account',
    session_id: randomUUID(),
    thumbprint,
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:browser-device',
    nonce: 'A'.repeat(43),
    issued_at: 100,
    expires_at: 60100,
  }
  const signature = await page.evaluate(
    async (payload) => {
      const key = Reflect.get(globalThis, 'browserProofPrivateKey')
      const bytes = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          key,
          new Uint8Array(payload),
        ),
      )
      return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
    },
    Array.from(browserDeviceProofPayload(challenge)),
  )
  expect(await verifyBrowserDeviceProof(challenge, publicKey, signature)).toBe(
    true,
  )
  expect(
    await verifyBrowserDeviceProof(
      { ...challenge, farm_id: randomUUID() },
      publicKey,
      signature,
    ),
  ).toBe(false)
})
