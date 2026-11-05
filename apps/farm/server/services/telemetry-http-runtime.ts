import { loadTelemetryVerificationKeys } from './telemetry-key-registry.ts'
import type { Sql } from 'postgres'
import {
  PostgresConnectorCredentialAcceptance,
  type CredentialAcceptanceConfig,
} from '../storage/postgres-connector-credential-acceptance.ts'
import { createTelemetryHttpHandler } from './telemetry-http.ts'

/** Explicit bootstrap only; no automatic environment or pairing credential reuse. */
export async function createTelemetryHttpRuntime(input: {
  sql: Sql
  keyFile: string
  config: Omit<CredentialAcceptanceConfig, 'publicKeys' | 'purpose'>
  bodyTimeoutMs: number
}) {
  const rows =
    await input.sql`SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, pg_has_role(current_user,'farm_connector_telemetry_writer','USAGE') AS allowed, pg_has_role(current_user,'farm_pairing_runtime','MEMBER') AS pairing, pg_has_role(current_user,'farm_connector_revoker','MEMBER') AS revoker FROM pg_roles r WHERE r.rolname=current_user`
  const role = rows[0]
  if (
    !role ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls ||
    role.allowed !== true ||
    role.pairing ||
    role.revoker
  )
    throw new Error('Invalid telemetry database role')
  const keys = await loadTelemetryVerificationKeys(input.keyFile)
  const store = new PostgresConnectorCredentialAcceptance(input.sql, {
    ...input.config,
    purpose: 'telemetry-ingestion',
    publicKeys: keys,
  })
  return createTelemetryHttpHandler(store, input.bodyTimeoutMs)
}

type Handler = Awaited<ReturnType<typeof createTelemetryHttpRuntime>>
let activeHandler: Handler | undefined
/** Called only by future trusted Node startup after explicit configuration. */
export async function activateTelemetryHttpRuntime(
  input: Parameters<typeof createTelemetryHttpRuntime>[0],
): Promise<void> {
  if (activeHandler) throw new Error('Telemetry runtime already active')
  const handler = await createTelemetryHttpRuntime(input)
  if (activeHandler) throw new Error('Telemetry runtime already active')
  activeHandler = handler
}
export function telemetryHttpRuntime(): Handler | undefined {
  return activeHandler
}
