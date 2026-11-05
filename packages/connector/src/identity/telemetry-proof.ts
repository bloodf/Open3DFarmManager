import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto'
import {
  TelemetryProofChallenge,
  telemetryProofPayload,
} from '../../../farm-protocol/src/telemetry-proof.ts'
import { PairingProofOrigin } from '../../../farm-protocol/src/pairing-proof.ts'
/** Signs only this exact bounded POST body; no key export or network operation. */
export function signTelemetryProof(input: {
  challenge: unknown
  privateKey: KeyObject
  token: string
  body: Uint8Array
  expectedOrigin: string
  expectedAudience: string
  expectedConnectionId: string
  now: number
}): string {
  const challenge = TelemetryProofChallenge.parse(input.challenge)
  if (
    input.privateKey.type !== 'private' ||
    input.privateKey.asymmetricKeyType !== 'ed25519' ||
    typeof input.token !== 'string' ||
    input.token.length < 1 ||
    input.token.length > 8192 ||
    !(input.body instanceof Uint8Array) ||
    input.body.byteLength < 1 ||
    input.body.byteLength > 65536
  )
    throw new Error('Invalid telemetry proof input')
  const body = Buffer.from(input.body)
  const der = createPublicKey(input.privateKey).export({
    format: 'der',
    type: 'spki',
  })
  if (
    challenge.origin !== PairingProofOrigin.parse(input.expectedOrigin) ||
    challenge.audience !== input.expectedAudience ||
    challenge.connection_id !== input.expectedConnectionId ||
    challenge.public_key_spki !== der.toString('base64url') ||
    challenge.fingerprint !==
      'SHA256:' + createHash('sha256').update(der).digest('base64url') ||
    challenge.token_hash !==
      createHash('sha256').update(input.token).digest('base64url') ||
    challenge.body_sha256 !==
      createHash('sha256').update(body).digest('base64url') ||
    challenge.body_bytes !== body.byteLength ||
    !Number.isSafeInteger(input.now) ||
    input.now < challenge.issued_at ||
    input.now >= challenge.expires_at
  )
    throw new Error('Telemetry proof is not current or trusted')
  return sign(
    null,
    telemetryProofPayload(challenge),
    input.privateKey,
  ).toString('base64url')
}
