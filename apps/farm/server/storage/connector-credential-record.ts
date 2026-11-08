/** Immutable issuance metadata only; callers retain all authorization checks. */
export interface ConnectorCredentialRecord {
  jti: string
  agent_id: string
  farm_id: string
  fingerprint: string
  thumbprint: string
  kid: string
  issuer: string
  audience: string
  issued_at: number
  expires_at: number
}
export type ConnectorCredentialIdentityRecord = Omit<
  ConnectorCredentialRecord,
  'agent_id' | 'kid'
>
export type ConnectorCredentialRevocationRecord = Pick<
  ConnectorCredentialRecord,
  'jti' | 'farm_id' | 'fingerprint'
>
