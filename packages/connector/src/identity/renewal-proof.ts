import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import {
  RenewalChallenge,
  RenewalIdentity,
  RenewalIntent,
  renewalIntentPayload,
  renewalProofPayload,
} from '../../../farm-protocol/src/credential-renewal.ts'
import { PairingProofOrigin } from '../../../farm-protocol/src/pairing-proof.ts'

function ed25519(privateKey: KeyObject) {
  if (
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'ed25519'
  )
    throw new Error('Invalid renewal proof key')
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
}

/** Signs only a current renewal challenge bound to this key and the expected predecessor. */
export function signRenewalProof(input: {
  challenge: unknown
  privateKey: KeyObject
  expectedMode: 'issue' | 'readback'
  expectedIdentity: RenewalIdentity
  expectedFarmId: string
  expectedOrigin: string
  expectedAudience: string
  now: number
}): string {
  const challenge = RenewalChallenge.parse(input.challenge)
  const der = ed25519(input.privateKey)
  if (
    challenge.mode !== input.expectedMode ||
    canonicalize(challenge.identity) !==
      canonicalize(RenewalIdentity.parse(input.expectedIdentity)) ||
    challenge.farmId !== input.expectedFarmId ||
    challenge.origin !== PairingProofOrigin.parse(input.expectedOrigin) ||
    challenge.audience !== input.expectedAudience ||
    challenge.publicKeySpki !== der.toString('base64url') ||
    challenge.fingerprint !==
      'SHA256:' + createHash('sha256').update(der).digest('base64url') ||
    !Number.isSafeInteger(input.now) ||
    input.now < challenge.issuedAt ||
    input.now >= challenge.expiresAt
  )
    throw new Error('Renewal proof is not current or trusted')
  return sign(null, renewalProofPayload(challenge), input.privateKey).toString(
    'base64url',
  )
}

/** Readback intent: proves possession for the exact predecessor, origin and audience only. */
export function signRenewalIntent(input: {
  intent: unknown
  privateKey: KeyObject
  expectedOrigin: string
  expectedAudience: string
}): string {
  const intent = RenewalIntent.parse(input.intent)
  ed25519(input.privateKey)
  if (
    intent.origin !== PairingProofOrigin.parse(input.expectedOrigin) ||
    intent.audience !== input.expectedAudience
  )
    throw new Error('Renewal intent is not trusted')
  return sign(null, renewalIntentPayload(intent), input.privateKey).toString(
    'base64url',
  )
}
