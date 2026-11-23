import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto'
import {
  CONNECTOR_LIBRARY_PROOF_HEADER,
  CONNECTOR_LIBRARY_PROOF_TTL_MS,
  CONNECTOR_LIBRARY_SIGNATURE_HEADER,
  ConnectorLibraryProof,
  connectorLibraryProofPayload,
} from '../../../farm-protocol/src/connector-library-proof.ts'

/**
 * Signs a fresh single-use proof for one library download or relay request
 * (#580): bound to this credential, this agent and farm, and a random nonce.
 * Returns the two headers to send next to the bearer credential.
 */
export function signLibraryProof(input: {
  privateKey: KeyObject
  token: string
  agentId: string
  farmId: string
  now: number
}): Record<string, string> {
  if (
    input.privateKey.type !== 'private' ||
    input.privateKey.asymmetricKeyType !== 'ed25519' ||
    typeof input.token !== 'string' ||
    input.token.length < 1 ||
    input.token.length > 8192 ||
    !Number.isSafeInteger(input.now)
  )
    throw new Error('Invalid library proof input')
  const proof = ConnectorLibraryProof.parse({
    v: 1,
    purpose: 'connector-library',
    agent_id: input.agentId,
    farm_id: input.farmId,
    token_hash: createHash('sha256').update(input.token).digest('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    issued_at: input.now,
    expires_at: input.now + CONNECTOR_LIBRARY_PROOF_TTL_MS,
  })
  return {
    [CONNECTOR_LIBRARY_PROOF_HEADER]: Buffer.from(
      JSON.stringify(proof),
    ).toString('base64url'),
    [CONNECTOR_LIBRARY_SIGNATURE_HEADER]: sign(
      null,
      connectorLibraryProofPayload(proof),
      input.privateKey,
    ).toString('base64url'),
  }
}
