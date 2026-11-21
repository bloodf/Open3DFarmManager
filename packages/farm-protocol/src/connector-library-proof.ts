import { z } from 'zod'
import { canonicalize } from './canonical.ts'

/**
 * Per-request proof of possession for the Connector library download and
 * relay endpoints (#580). The Connector signs a short-lived, single-use
 * statement bound to its credential (token hash), identity and a fresh nonce
 * with its enrolled key; a bearer token alone is never enough.
 */
export const CONNECTOR_LIBRARY_PROOF_HEADER = 'x-connector-proof'
export const CONNECTOR_LIBRARY_SIGNATURE_HEADER = 'x-connector-proof-signature'
/** Longest lifetime of one proof. */
export const CONNECTOR_LIBRARY_PROOF_TTL_MS = 60_000

const id = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const ConnectorLibraryProof = z
  .strictObject({
    v: z.literal(1),
    purpose: z.literal('connector-library'),
    agent_id: id,
    farm_id: id,
    token_hash: digest,
    nonce: digest,
    issued_at: time,
    expires_at: time,
  })
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= CONNECTOR_LIBRARY_PROOF_TTL_MS,
  )
export type ConnectorLibraryProof = z.infer<typeof ConnectorLibraryProof>

export const CONNECTOR_LIBRARY_SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/

export function connectorLibraryProofPayload(input: unknown): Uint8Array {
  return new TextEncoder().encode(
    'Open3DFarmManager/connector-library-proof/v1\0' +
      canonicalize(ConnectorLibraryProof.parse(input)),
  )
}
