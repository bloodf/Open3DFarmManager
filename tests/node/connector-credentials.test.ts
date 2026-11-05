import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, sign, KeyObject, generateKeyPairSync } from 'node:crypto'
import {
  connectorKeyBinding,
  issueConnectorCredential,
  verifyConnectorCredential,
} from '../../apps/farm/server/utils/connector-credentials.ts'

const makeKeys = async () => {
  const pair = generateKeyPairSync('ed25519')
  const privateKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pair.privateKey.export({ format: 'der', type: 'pkcs8' }),
    'Ed25519',
    true,
    ['sign'],
  )
  const publicKey = await globalThis.crypto.subtle.importKey(
    'spki',
    pair.publicKey.export({ format: 'der', type: 'spki' }),
    'Ed25519',
    true,
    ['verify'],
  )
  return { privateKey, publicKey }
}
const asSpki = async (key: CryptoKey) =>
  Buffer.from(await globalThis.crypto.subtle.exportKey('spki', key)).toString(
    'base64url',
  )

async function fixture() {
  const signer = await makeKeys()
  const device = await makeKeys()
  const config = {
    issuer: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    kid: 'key_1',
    privateKey: signer.privateKey,
    ttlSeconds: 300,
  }
  const binding = {
    agentId: randomUUID(),
    farmId: randomUUID(),
    publicKeySpki: await asSpki(device.publicKey),
  }
  const issue = {
    ...config,
    ...binding,
    nowSeconds: 2000000000,
    jti: randomUUID(),
  }
  const token = await issueConnectorCredential(issue)
  const verify = {
    ...binding,
    token,
    issuer: config.issuer,
    audience: config.audience,
    publicKeys: new Map([[config.kid, signer.publicKey]]),
    ttlSeconds: config.ttlSeconds,
    nowSeconds: issue.nowSeconds,
  }
  return { signer, issue, verify, token }
}
function signedRaw(header: string, payload: string, key: CryptoKey) {
  const body =
    Buffer.from(header).toString('base64url') +
    '.' +
    Buffer.from(payload).toString('base64url')
  return (
    body +
    '.' +
    sign(null, Buffer.from(body), KeyObject.from(key)).toString('base64url')
  )
}

test('signs and verifies a key-bound credential with explicit lifetime', async () => {
  const f = await fixture()
  const binding = await connectorKeyBinding(f.issue.publicKeySpki)
  assert.deepEqual(await verifyConnectorCredential(f.verify), {
    agentId: f.issue.agentId,
    farmId: f.issue.farmId,
    fingerprint: binding.fingerprint,
    thumbprint: binding.thumbprint,
    jti: f.issue.jti,
    issuedAt: f.issue.nowSeconds,
    expiresAt: f.issue.nowSeconds + 300,
  })
})

test('rejects signature, algorithm, issuer, audience, key and binding mismatches', async () => {
  const f = await fixture()
  const parts = f.token.split('.')
  const signature = Buffer.from(parts[2]!, 'base64url')
  signature[0] = signature[0]! ^ 1
  const tampered =
    parts[0] + '.' + parts[1] + '.' + signature.toString('base64url')
  const wrongSigner = await makeKeys()
  const wrongDevice = await makeKeys()
  for (const override of [
    { token: tampered },
    { issuer: 'https://other.example' },
    { audience: 'other' },
    { agentId: randomUUID() },
    { farmId: randomUUID() },
    { publicKeySpki: await asSpki(wrongDevice.publicKey) },
    { publicKeys: new Map() },
    { publicKeys: new Map([['key_1', wrongSigner.publicKey]]) },
    { nowSeconds: f.issue.nowSeconds + 300 },
    { nowSeconds: f.issue.nowSeconds - 1 },
    { ttlSeconds: 301 },
  ])
    await assert.rejects(
      verifyConnectorCredential({ ...f.verify, ...override }),
    )
  const payload = Buffer.from(parts[1]!, 'base64url').toString()
  await assert.rejects(
    verifyConnectorCredential({
      ...f.verify,
      token: signedRaw(
        '{"alg":"HS256","typ":"JWT","kid":"key_1"}',
        payload,
        f.signer.privateKey,
      ),
    }),
  )
})

test('rejects ambiguous or extra fields, invalid times and malformed encodings', async () => {
  const f = await fixture()
  const [head, body] = f.token.split('.')
  const header = Buffer.from(head!, 'base64url').toString()
  const payload = Buffer.from(body!, 'base64url').toString()
  const invalid = [
    signedRaw(
      header.replace('"kid":"key_1"', '"kid":"key_1","kid":"key_1"'),
      payload,
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace('"farm_id":', '"farm_id":"duplicate","farm_id":'),
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace(/}$/, ',"extra":true}'),
      f.signer.privateKey,
    ),
    signedRaw(
      header.replace(/}$/, ',"extra":true}'),
      payload,
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace(/"jti":"[^"]+"/, '"jti":"invalid"'),
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace(/"jkt":"[^"]+"/, '"jkt":"invalid"'),
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace(/"exp":\d+/, '"exp":2000000301'),
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace(/"iat":\d+/, '"iat":2000000001'),
      f.signer.privateKey,
    ),
    signedRaw(
      header,
      payload.replace(/"aud":"[^"]+"/, '"aud":["open3dfarmmanager:connector"]'),
      f.signer.privateKey,
    ),
    'A'.repeat(8193),
    f.token + '=',
  ]
  for (const token of invalid)
    await assert.rejects(verifyConnectorCredential({ ...f.verify, token }))
  for (const override of [
    { ttlSeconds: 0 },
    { ttlSeconds: 3601 },
    { jti: 'bad' },
    { nowSeconds: -1 },
    { kid: 'bad.key' },
  ])
    await assert.rejects(issueConnectorCredential({ ...f.issue, ...override }))
})
