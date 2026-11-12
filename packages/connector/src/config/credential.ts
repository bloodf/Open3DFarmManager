import { z } from 'zod'
import {
  PairingPollResponse,
  PairingStartResponse,
} from '../../../farm-protocol/src/pairing.ts'
import { CredentialProofId } from '../../../farm-protocol/src/credential-proof.ts'
import { readPrivateJsonFile } from './local.ts'

export const CredentialFile = z.strictObject({
  version: z.literal(1),
  expected_fingerprint: PairingStartResponse.shape.fingerprint,
  approval: PairingPollResponse,
  // Present only for a renewed successor; a root credential is its own root.
  root_jti: CredentialProofId.optional(),
})

export type CredentialFile = z.infer<typeof CredentialFile>

/**
 * Reads an approved envelope bound to this identity without the expiry check.
 * Only for startup readback recovery; never use the result to authenticate.
 */
export function readCredentialEnvelope(
  path: string,
  expectedFingerprint: string,
) {
  const file = CredentialFile.parse(
    readPrivateJsonFile(path, { maxBytes: 16 * 1024, maxStringChars: 8192 }),
  )
  if (
    file.approval.status !== 'approved' ||
    file.expected_fingerprint !== expectedFingerprint
  )
    throw new Error('Invalid local runtime credential')
  return {
    ...file.approval,
    expectedFingerprint: file.expected_fingerprint,
    ...(file.root_jti ? { root_jti: file.root_jti } : {}),
  }
}

/** A local credential envelope is not a JWT authorization decision. */
export function readRuntimeCredential(
  path: string,
  expectedFingerprint: string,
  now: number,
) {
  const credential = readCredentialEnvelope(path, expectedFingerprint)
  if (!Number.isSafeInteger(now) || now < 0 || credential.expires_at <= now)
    throw new Error('Invalid or expired local runtime credential')
  return credential
}
export type RuntimeCredential = ReturnType<typeof readRuntimeCredential>
