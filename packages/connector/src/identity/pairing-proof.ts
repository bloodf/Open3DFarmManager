import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto'
import {
  PairingProofChallenge,
  PairingProofOrigin,
  PairingProofAudience,
  pairingProofPayload,
} from '../../../farm-protocol/src/pairing-proof.ts'

/** Local signing primitive. No networking, identity loading, pairing approval or credentials. */
export function signPairingProof(input: {
  challenge: unknown
  privateKey: KeyObject
  expectedOrigin: string
  expectedAudience: string
  now: number
}): string {
  const { privateKey, now } = input
  if (
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'ed25519'
  )
    throw new Error('Expected an Ed25519 private key')
  const challenge = PairingProofChallenge.parse(input.challenge)
  if (
    challenge.origin !== PairingProofOrigin.parse(input.expectedOrigin) ||
    challenge.audience !== PairingProofAudience.parse(input.expectedAudience) ||
    !Number.isSafeInteger(now) ||
    now < challenge.issued_at ||
    now >= challenge.expires_at
  )
    throw new Error('Pairing proof is not current or trusted')
  const publicDer = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  })
  if (
    challenge.public_key_spki !== publicDer.toString('base64url') ||
    challenge.fingerprint !==
      'SHA256:' + createHash('sha256').update(publicDer).digest('base64url')
  )
    throw new Error('Pairing proof identity mismatch')
  return sign(null, pairingProofPayload(challenge), privateKey).toString(
    'base64url',
  )
}
