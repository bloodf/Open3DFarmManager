import { expect, test } from 'vitest'
import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { signPairingProof } from '../../packages/connector/src/identity/pairing-proof.ts'
import {
  PairingProofChallenge,
  PairingProofCompletion,
  PairingProofOrigin,
  pairingProofPayload,
} from '../../packages/farm-protocol/src/pairing-proof.ts'

const privateKey = createPrivateKey({
  key: Buffer.from('302e020100300506032b657004220420' + '00'.repeat(32), 'hex'),
  format: 'der',
  type: 'pkcs8',
})
const identity = new ConnectorIdentity(privateKey)
const challenge = {
  v: 1 as const,
  agent_id: '11111111-1111-4111-8111-111111111111',
  public_key_spki: identity.publicKeySpki,
  fingerprint: identity.fingerprint,
  origin: 'https://farm.example',
  audience: 'open3dfarmmanager:pairing',
  nonce: 'A'.repeat(43),
  issued_at: 100,
  expires_at: 60100,
}
const signing = {
  challenge,
  privateKey,
  expectedOrigin: challenge.origin,
  expectedAudience: challenge.audience,
  now: 100,
}

test('pairing payload has a fixed domain and canonical sorted JSON independent of input key order', () => {
  const expected =
    'Open3DFarmManager/pairing-proof/v1\0' +
    `{"agent_id":"${challenge.agent_id}","audience":"open3dfarmmanager:pairing","expires_at":60100,"fingerprint":"${identity.fingerprint}","issued_at":100,"nonce":"${challenge.nonce}","origin":"https://farm.example","public_key_spki":"${identity.publicKeySpki}","v":1}`
  expect(new TextDecoder().decode(pairingProofPayload(challenge))).toBe(
    expected,
  )
  expect(
    pairingProofPayload(
      Object.fromEntries(Object.entries(challenge).reverse()),
    ),
  ).toEqual(pairingProofPayload(challenge))
  const signature = signPairingProof(signing)
  expect(
    verify(
      null,
      Buffer.from(expected),
      privateKey,
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(true)
  expect(
    verify(
      null,
      Buffer.from('Open3DFarmManager/connector-proof/v1\0' + expected),
      privateKey,
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(false)
})

test('signer requires matching Ed25519 identity, trusted server origin/audience and current challenge', () => {
  for (const patch of [
    { expectedOrigin: 'https://other.example' },
    { expectedAudience: 'another:audience' },
    { now: 99 },
    { now: 60100 },
    { now: NaN },
    { privateKey: generateKeyPairSync('ed25519').privateKey },
    {
      privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey,
    },
    { challenge: { ...challenge, fingerprint: 'SHA256:' + 'A'.repeat(43) } },
  ])
    expect(() => signPairingProof({ ...signing, ...patch })).toThrow()
})

test('proof contracts reject noncanonical identities, encodings, origins, lifetimes and extra fields', () => {
  for (const origin of [
    'https://farm.example/',
    'https://user:password@farm.example',
    'https://farm.example/path',
    'http://farm.example',
    'null',
  ])
    expect(PairingProofOrigin.safeParse(origin).success).toBe(false)
  for (const origin of [
    'https://farm.example',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://[::1]:3000',
  ])
    expect(PairingProofOrigin.safeParse(origin).success).toBe(true)
  for (const patch of [
    { expires_at: 100 },
    { expires_at: 60101 },
    { nonce: 'A'.repeat(42) + 'B' },
    { audience: 'has whitespace' },
    { agent_id: 'NOT-A-UUID' },
    { token: 'forbidden' },
  ])
    expect(
      PairingProofChallenge.safeParse({ ...challenge, ...patch }).success,
    ).toBe(false)
  const completion = {
    device_code: 'A'.repeat(43),
    challenge,
    signature: signPairingProof(signing),
  }
  expect(PairingProofCompletion.safeParse(completion).success).toBe(true)
  expect(
    PairingProofCompletion.safeParse({
      ...completion,
      signature: completion.signature + '=',
    }).success,
  ).toBe(false)
  expect(
    PairingProofCompletion.safeParse({
      ...completion,
      signature: 'A'.repeat(85) + 'B',
    }).success,
  ).toBe(false)
})
