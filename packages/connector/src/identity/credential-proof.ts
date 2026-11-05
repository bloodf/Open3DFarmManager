import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto'
import {
  CredentialProofChallenge,
  CredentialProofPurpose,
  credentialProofPayload,
} from '../../../farm-protocol/src/credential-proof.ts'
import { PairingProofOrigin } from '../../../farm-protocol/src/pairing-proof.ts'

/** Narrow proof signing only; the local identity key never leaves its owner. */
export function signCredentialProof(input: {
  challenge: unknown
  privateKey: KeyObject
  token: string
  expectedOrigin: string
  expectedAudience: string
  expectedPurpose: CredentialProofPurpose
  expectedConnectionId: string
  now: number
}): string {
  const challenge = CredentialProofChallenge.parse(input.challenge)
  if (
    input.privateKey.type !== 'private' ||
    input.privateKey.asymmetricKeyType !== 'ed25519' ||
    typeof input.token !== 'string' ||
    input.token.length < 1 ||
    input.token.length > 8192
  )
    throw new Error('Invalid credential proof input')
  const der = createPublicKey(input.privateKey).export({
    format: 'der',
    type: 'spki',
  })
  if (
    challenge.origin !== PairingProofOrigin.parse(input.expectedOrigin) ||
    challenge.audience !== input.expectedAudience ||
    challenge.purpose !== CredentialProofPurpose.parse(input.expectedPurpose) ||
    challenge.connection_id !== input.expectedConnectionId ||
    challenge.token_hash !==
      createHash('sha256').update(input.token).digest('base64url') ||
    challenge.public_key_spki !== der.toString('base64url') ||
    challenge.fingerprint !==
      'SHA256:' + createHash('sha256').update(der).digest('base64url') ||
    !Number.isSafeInteger(input.now) ||
    input.now < challenge.issued_at ||
    input.now >= challenge.expires_at
  )
    throw new Error('Credential proof is not current or trusted')
  return sign(
    null,
    credentialProofPayload(challenge),
    input.privateKey,
  ).toString('base64url')
}
