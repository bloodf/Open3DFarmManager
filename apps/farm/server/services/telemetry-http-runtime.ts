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
  const rows = await input.sql`SELECT
      pg_has_role(current_user, 'farm_connector_telemetry_writer', 'USAGE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE pg_has_role(current_user, r.oid, 'MEMBER')
          AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
            OR r.rolname NOT IN (current_user, 'farm_connector_telemetry_writer', 'farm_connector_credential_acceptor'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_database d
        WHERE d.datname = current_database() AND pg_has_role(current_user, d.datdba, 'MEMBER')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname = 'farm' AND pg_has_role(current_user, n.nspowner, 'MEMBER')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'farm' AND pg_has_role(current_user, c.relowner, 'MEMBER')
      ) AS allowed`
  const role = rows[0]
  if (!role || role.allowed !== true)
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

/** The lifecycle owner calls this before closing its dedicated pool. */
export function deactivateTelemetryHttpRuntime(): void {
  activeHandler = undefined
}
