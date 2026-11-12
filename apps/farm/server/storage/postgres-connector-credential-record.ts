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
/**
 * Successors inherit the root's farm and key binding (0021). With an exact jti
 * this returns that successor; without one, the newest successor whose own
 * lifetime contains observedAt (milliseconds). Rows are immutable, so no lock.
 */
export function readSignallingSuccessorRecords(
  tx: TransactionSql,
  rootJti: string,
  jti: string | null,
  observedAt: number,
) {
  return tx<
    ConnectorCredentialIdentityRecord[]
  >`SELECT s.jti, r.farm_id, r.fingerprint, r.thumbprint, s.issuer, s.audience, s.issued_at::float8 AS issued_at, s.expires_at::float8 AS expires_at FROM farm.connector_credential_successors s JOIN farm.connector_credentials r ON r.jti = s.root_jti WHERE s.root_jti = ${rootJti}::uuid AND ${jti === null ? tx`s.issued_at * 1000 <= ${observedAt} AND s.expires_at * 1000 > ${observedAt}` : tx`s.jti = ${jti}::uuid`} ORDER BY s.ordinal DESC LIMIT 1`
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
