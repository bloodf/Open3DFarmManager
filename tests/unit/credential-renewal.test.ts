import { describe, test, expect } from 'vitest'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import {
  RenewalIdentity,
  RenewalRequest,
  RenewalChallenge,
  RenewalCompletion,
  RenewalReservation,
  renewalIntentPayload,
  renewalProofPayload,
} from '../../packages/farm-protocol/src/credential-renewal.ts'
const identity = {
  kind: 'root',
  rootJti: '12345678-1234-4234-8234-123456789abc',
  jti: '12345678-1234-4234-8234-123456789abc',
  agentId: '12345678-1234-4234-8234-123456789abd',
}
const keys = generateKeyPairSync('ed25519')
const spki = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64url')
const intent = {
  v: 1,
  identity,
  farmId: '12345678-1234-4234-8234-123456789abe',
  origin: 'https://farm.example',
  audience: 'farm',
}
const reservation = {
  childJti: '12345678-1234-4234-8234-123456789abf',
  ordinal: 1,
  kid: 'fixture',
  issuer: 'https://farm.example',
  audience: 'farm',
  issuedAt: 1000,
  expiresAt: 1300,
  tokenHash: 'A'.repeat(43),
  codec: 1,
}
const challenge = {
  v: 1,
  mode: 'issue',
  identity,
  farmId: intent.farmId,
  origin: intent.origin,
  audience: intent.audience,
  publicKeySpki: spki,
  fingerprint: 'SHA256:' + 'A'.repeat(43),
  thumbprint: 'A'.repeat(43),
  reservation,
  nonce: 'A'.repeat(43),
  attempt: 1,
  issuedAt: 1000000,
  expiresAt: 1030000,
}
describe('dedicated renewal protocol', () => {
  test('intent has a literal real NUL domain and canonical bytes', () => {
    const bytes = renewalIntentPayload(intent)
    expect(Buffer.from(bytes).toString()).toBe(
      'Open3DFarmManager/credential-renewal-readback-intent/v1\u0000' +
        canonicalize(intent),
    )
    expect(bytes.indexOf(0)).toBe(
      Buffer.byteLength(
        'Open3DFarmManager/credential-renewal-readback-intent/v1',
      ),
    )
    expect(Buffer.from(bytes).includes(Buffer.from([0]))).toBe(true)
  })
  test('proof domain is not existing signalling/telemetry authority', () => {
    const bytes = renewalProofPayload(challenge)
    expect(Buffer.from(bytes).toString()).toBe(
      'Open3DFarmManager/credential-renewal/v1\u0000' + canonicalize(challenge),
    )
    const signature = sign(null, bytes, keys.privateKey)
    expect(
      verify(
        null,
        renewalProofPayload({ ...challenge, mode: 'readback' }),
        keys.publicKey,
        signature,
      ),
    ).toBe(false)
    expect(
      verify(null, renewalIntentPayload(intent), keys.publicKey, signature),
    ).toBe(false)
  })
  test('strict modes and exact identity reject cross-kind/root ambiguity', () => {
    expect(RenewalIdentity.safeParse(identity).success).toBe(true)
    for (const value of [
      { ...identity, kind: 'successor' },
      { ...identity, jti: reservation.childJti },
      { ...identity, extra: true },
    ])
      expect(RenewalIdentity.safeParse(value).success).toBe(false)
    expect(
      RenewalRequest.safeParse({
        mode: 'issue',
        identity,
        farmId: intent.farmId,
        token: 'token',
      }).success,
    ).toBe(true)
    for (const value of [
      { mode: 'renew', identity },
      {
        mode: 'readback',
        intent,
        identitySignature: 'A'.repeat(86),
        token: 'expired',
      },
      {
        mode: 'issue',
        identity,
        farmId: intent.farmId,
        token: 'token',
        purpose: 'telemetry-ingestion',
      },
    ])
      expect(RenewalRequest.safeParse(value).success).toBe(false)
  })
  test('reservation and challenge bounds reject partial, nonfinite, altered fields', () => {
    expect(RenewalReservation.parse(reservation)).toEqual(reservation)
    for (const patch of [
      { ordinal: 0 },
      { codec: 2 },
      { issuedAt: Infinity },
      { expiresAt: 1000 },
      { expiresAt: 4601 },
      { extra: true },
    ])
      expect(
        RenewalReservation.safeParse({ ...reservation, ...patch }).success,
      ).toBe(false)
    for (const patch of [
      { expiresAt: 1060001 },
      { nonce: 'bad' },
      { attempt: 0 },
      { extra: true },
    ])
      expect(
        RenewalChallenge.safeParse({ ...challenge, ...patch }).success,
      ).toBe(false)
    expect(
      RenewalCompletion.safeParse({
        request: {
          mode: 'issue',
          identity,
          farmId: intent.farmId,
          token: 'token',
        },
        challenge,
        signature: 'A'.repeat(86),
        extra: 1,
      }).success,
    ).toBe(false)
  })
})
