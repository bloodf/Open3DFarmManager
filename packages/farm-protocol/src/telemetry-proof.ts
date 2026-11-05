import { z } from 'zod'
import {
  CredentialProofChallenge,
  CredentialProofRequest,
} from './credential-proof.ts'
import { canonicalize } from './canonical.ts'
export const TELEMETRY_OPERATION_PATH = '/api/connector/telemetry'
export const TelemetryProofChallenge = z
  .strictObject({
    ...CredentialProofChallenge.shape,
    v: z.literal(2),
    purpose: z.literal('telemetry-ingestion'),
    method: z.literal('POST'),
    path: z.literal(TELEMETRY_OPERATION_PATH),
    body_sha256: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
    body_bytes: z.number().int().min(1).max(65536),
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= 60000,
  )
export type TelemetryProofChallenge = z.infer<typeof TelemetryProofChallenge>
export const TelemetryProofCompletion = CredentialProofRequest.extend({
  challenge: TelemetryProofChallenge,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
})
export function telemetryProofPayload(input: unknown): Uint8Array {
  return new TextEncoder().encode(
    'Open3DFarmManager/credential-operation-proof/v2\0' +
      canonicalize(TelemetryProofChallenge.parse(input)),
  )
}
