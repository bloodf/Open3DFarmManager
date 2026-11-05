import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  BrowserDeviceProofChallenge,
  browserDeviceProofPayload,
  commandBrowserIdentity,
  signBrowserDeviceProof,
  validateBrowserDevicePublicKey,
  verifyBrowserDeviceProof,
} from '../../packages/farm-protocol/src/browser-device-proof.ts'

async function keys() {
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
  return { pair, ...(await validateBrowserDevicePublicKey(publicKey)) }
}

async function fixture() {
  const key = await keys()
  const challenge = {
    v: 1 as const,
    purpose: 'enroll' as const,
    challenge_id: randomUUID(),
    farm_id: randomUUID(),
    key_id: randomUUID(),
    account_id: 'legacy_account',
    session_id: randomUUID(),
    thumbprint: key.thumbprint,
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:browser-device',
    nonce: 'A'.repeat(43),
    issued_at: 100,
    expires_at: 60100,
  }
  return { ...key, challenge }
}

test('P-256 public key validation rejects private material, noncanonical coordinates and invalid points', async () => {
  const { publicKey, thumbprint } = await keys()
  expect(
    (await validateBrowserDevicePublicKey({ ...publicKey })).thumbprint,
  ).toBe(thumbprint)
  for (const bad of [
    { ...publicKey, d: 'A'.repeat(43) },
    { ...publicKey, x: publicKey.x + '=' },
    { ...publicKey, x: 'A'.repeat(42) + 'B' },
    { ...publicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) },
    { ...publicKey, crv: 'P-384' },
  ])
    await expect(validateBrowserDevicePublicKey(bad)).rejects.toThrow()
})

test('proof signs a canonical domain-separated payload and rejects tampering and scope substitution', async () => {
  const { pair, publicKey, challenge } = await fixture()
  const signature = await signBrowserDeviceProof(challenge, pair.privateKey)
  expect(await verifyBrowserDeviceProof(challenge, publicKey, signature)).toBe(
    true,
  )
  const payload = new TextDecoder().decode(browserDeviceProofPayload(challenge))
  expect(
    payload.startsWith('Open3DFarmManager/browser-device-proof/v1\0'),
  ).toBe(true)
  expect(
    browserDeviceProofPayload(
      Object.fromEntries(Object.entries(challenge).reverse()),
    ),
  ).toEqual(browserDeviceProofPayload(challenge))
  for (const patch of [
    { purpose: 'recover' },
    { farm_id: randomUUID() },
    { key_id: randomUUID() },
    { challenge_id: randomUUID() },
    { account_id: 'other' },
    { session_id: randomUUID() },
    { origin: 'https://other.example' },
    { audience: 'other' },
    { nonce: 'B'.repeat(42) + 'A' },
    { issued_at: 101 },
    { expires_at: 60099 },
    { thumbprint: (await keys()).thumbprint },
  ])
    expect(
      await verifyBrowserDeviceProof(
        { ...challenge, ...patch },
        publicKey,
        signature,
      ),
    ).toBe(false)
  expect(
    await verifyBrowserDeviceProof(
      challenge,
      (await keys()).publicKey,
      signature,
    ),
  ).toBe(false)
  expect(
    await verifyBrowserDeviceProof(challenge, publicKey, signature + '='),
  ).toBe(false)
  expect(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      Uint8Array.from(Buffer.from(signature, 'base64url')),
      new TextEncoder().encode(
        payload.replace('browser-device-proof', 'pairing-proof'),
      ),
    ),
  ).toBe(false)
})

test('challenge bounds and legacy identity command compatibility fail closed', async () => {
  const { challenge } = await fixture()
  for (const patch of [
    { expires_at: 100 },
    { expires_at: 60101 },
    { origin: 'https://farm.example/' },
    { nonce: 'A'.repeat(42) + 'B' },
    { challenge_id: 'NOT-A-UUID' },
    { extra: true },
  ])
    expect(
      BrowserDeviceProofChallenge.safeParse({ ...challenge, ...patch }).success,
    ).toBe(false)
  expect(
    commandBrowserIdentity({
      accountId: 'legacy_account',
      transportSessionId: 'legacy_session',
    }),
  ).toEqual({ ok: false, reason: 'incompatible-identity' })
  const accountId = randomUUID(),
    sessionRecordId = randomUUID()
  expect(
    commandBrowserIdentity({ accountId, transportSessionId: sessionRecordId }),
  ).toEqual({ ok: true, user_id: accountId, session_id: sessionRecordId })
})
