import { z } from 'zod'
import {
  PairingPollResponse,
  PairingStartResponse,
} from '../../../farm-protocol/src/pairing.ts'
import { CredentialProofId } from '../../../farm-protocol/src/credential-proof.ts'
import { readPrivateJsonFile } from './local.ts'

const File = z.strictObject({
  version: z.literal(1),
  expected_fingerprint: PairingStartResponse.shape.fingerprint,
  approval: PairingPollResponse,
  // Present only for a renewed successor; a root credential is its own root.
  root_jti: CredentialProofId.optional(),
})

/** A local credential envelope is not a JWT authorization decision. */
export function readRuntimeCredential(
  path: string,
  expectedFingerprint: string,
  now: number,
) {
  const file = File.parse(
    readPrivateJsonFile(path, { maxBytes: 16 * 1024, maxStringChars: 8192 }),
  )
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    file.approval.status !== 'approved' ||
    file.expected_fingerprint !== expectedFingerprint ||
    file.approval.expires_at <= now
  )
    throw new Error('Invalid or expired local runtime credential')
  return {
    ...file.approval,
    expectedFingerprint: file.expected_fingerprint,
    ...(file.root_jti ? { root_jti: file.root_jti } : {}),
  }
}
export type RuntimeCredential = ReturnType<typeof readRuntimeCredential>
