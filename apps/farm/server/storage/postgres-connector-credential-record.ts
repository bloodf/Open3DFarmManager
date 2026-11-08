import type { TransactionSql } from 'postgres'
import type {
  ConnectorCredentialRecord,
  ConnectorCredentialIdentityRecord,
  ConnectorCredentialRevocationRecord,
} from './connector-credential-record.ts'

// Root metadata queries only. No transaction, validation or authority is added.
export function readAcceptanceCredentialRecords(
  tx: TransactionSql,
  agentId: string,
) {
  return tx<
    ConnectorCredentialRecord[]
  >`SELECT jti,agent_id,farm_id,fingerprint,thumbprint,kid,issuer,audience,issued_at::float8,expires_at::float8 FROM farm.connector_credentials WHERE agent_id=${agentId}::uuid FOR SHARE`
}
export function readSignallingCredentialRecords(
  tx: TransactionSql,
  agentId: string,
) {
  return tx<
    ConnectorCredentialIdentityRecord[]
  >`SELECT jti, farm_id, fingerprint, thumbprint, issuer, audience, issued_at::float8 AS issued_at, expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE agent_id = ${agentId}::uuid FOR SHARE`
}
export function readPauseNegotiationCredentialRecords(
  tx: TransactionSql,
  agentId: string,
) {
  return tx<
    ConnectorCredentialIdentityRecord[]
  >`SELECT jti,farm_id,fingerprint,thumbprint,issuer,audience,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE agent_id=${agentId}::uuid FOR UPDATE`
}
export function readPauseAuthorityCredentialRecords(
  tx: TransactionSql,
  agentId: string,
  jti: string,
) {
  return tx<
    ConnectorCredentialIdentityRecord[]
  >`SELECT jti,farm_id,fingerprint,thumbprint,issuer,audience,issued_at::float8 AS issued_at,expires_at::float8 AS expires_at FROM farm.connector_credentials WHERE jti=${jti}::uuid AND agent_id=${agentId}::uuid FOR UPDATE`
}
export function readRevocationCredentialRecords(
  tx: TransactionSql,
  agentId: string,
) {
  return tx<
    ConnectorCredentialRevocationRecord[]
  >`SELECT jti, farm_id, fingerprint FROM farm.connector_credentials WHERE agent_id = ${agentId}::uuid FOR SHARE`
}
