import { currentPauseNegotiationRuntime } from '../utils/pause-authority/runtime.ts'
import postgres, { type Sql } from 'postgres'
import type { SessionConfig } from 'nuxt/server'
import {
  PostgresSignallingAuthorization,
  SIGNALLING_IDLE_TIMEOUT_MS,
} from '../storage/postgres-signalling-authorization.ts'
import { loadTelemetryVerificationKeys } from './telemetry-key-registry.ts'
import { SignallingRuntime } from './signalling-runtime.ts'
import type { SignallingRuntimeConfig } from './signalling-runtime-config.ts'
import {
  DISABLED_SIGNALLING_METADATA,
  validatedSignallingMetadata,
  type SignallingMetadata,
  type EnabledSignallingMetadata,
} from './signalling-metadata.ts'
let active:
  | Readonly<{
      runtime: SignallingRuntime
      metadata: EnabledSignallingMetadata
    }>
  | undefined
export function signallingRuntime(): SignallingRuntime | undefined {
  return active?.runtime.isClosed === false ? active.runtime : undefined
}
export function signallingMetadata(): SignallingMetadata {
  return active?.runtime.isClosed === false
    ? active.metadata
    : DISABLED_SIGNALLING_METADATA
}
async function role(
  sql: Sql,
  required: 'farm_signalling_reader' | 'farm_connector_credential_acceptor',
): Promise<{ database: string; address: string | null; port: number | null }> {
  const rows = await sql`SELECT
    pg_has_role(current_user, ${required}, 'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname NOT IN (current_user,${required})))
    AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'MEMBER'))
    AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname='farm' AND pg_has_role(current_user,n.nspowner,'MEMBER'))
    AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='farm' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS allowed, current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port`
  if (rows[0]?.allowed !== true)
    throw new Error('Invalid signalling database role')
  const row = rows[0]
  if (
    typeof row.database !== 'string' ||
    (row.address !== null && typeof row.address !== 'string') ||
    (row.port !== null && !Number.isSafeInteger(row.port))
  )
    throw new Error('Invalid signalling database identity')
  return { database: row.database, address: row.address, port: row.port }
}
/** Config validation is synchronous in the plugin. Async SQL/key validation must
 * finish before the singleton is published; all upgrades deny while unavailable. */
export function createSignallingRuntimeLifecycle() {
  let runtime: SignallingRuntime | undefined
  let pools: Sql[] = []
  let pending: Promise<void> | undefined
  let closed = false
  return {
    start(
      input: SignallingRuntimeConfig,
      cookie: SessionConfig,
    ): Promise<void> {
      if (pending || runtime || closed || active)
        throw new Error('Signalling lifecycle unavailable')
      // Capture once before the first await; metadata and runtime use the same validated fields.
      const config = Object.freeze({ ...input })
      const metadata = validatedSignallingMetadata(config)
      const options = {
        max: 3,
        connect_timeout: 3,
        idle_timeout: 20,
        connection: { statement_timeout: 2000, lock_timeout: 1000 },
      }
      pending = (async () => {
        try {
          const keys = await loadTelemetryVerificationKeys(
            config.publicKeyRegistryPath,
          )
          if (closed) throw new Error('Signalling startup cancelled')
          const readerPool = postgres(config.readerDatabaseUrl, options)
          const proofPool = postgres(config.proofDatabaseUrl, options)
          pools = [readerPool, proofPool]
          const [readerIdentity, proofIdentity] = await Promise.all([
            role(readerPool, 'farm_signalling_reader'),
            role(proofPool, 'farm_connector_credential_acceptor'),
          ])
          if (
            readerIdentity.database !== proofIdentity.database ||
            readerIdentity.address !== proofIdentity.address ||
            readerIdentity.port !== proofIdentity.port
          )
            throw new Error('Mismatched signalling database endpoints')
          const { PostgresConnectorCredentialAcceptance } = await import(
            '../storage/postgres-connector-credential-acceptance.ts'
          )
          if (closed || active) throw new Error('Signalling startup cancelled')
          const reader = new PostgresSignallingAuthorization(readerPool, {
            issuer: config.issuer,
            origin: config.origin,
            audience: config.audience,
            idleTimeoutMs: SIGNALLING_IDLE_TIMEOUT_MS,
          })
          const credentials = new PostgresConnectorCredentialAcceptance(
            proofPool,
            {
              issuer: config.issuer,
              audience: config.audience,
              origin: config.origin,
              purpose: 'signalling',
              publicKeys: keys,
              ttlSeconds: config.tokenTtlSeconds,
              proofTtlMs: config.proofTtlMs,
            },
          )
          runtime = new SignallingRuntime({
            reader,
            credentials,
            origin: config.origin,
            cookie,
            pause: {
              current: currentPauseNegotiationRuntime,
              databaseIdentity: readerIdentity,
              credentialIssuer: config.issuer,
              credentialAudience: config.audience,
            },
          })
          active = Object.freeze({ runtime, metadata })
        } catch {
          closed = true
          await Promise.allSettled(
            pools.map((pool) => pool.end({ timeout: 3 })),
          )
          pools = []
          throw new Error('Signalling startup unavailable')
        }
      })()
      return pending
    },
    async close(): Promise<void> {
      closed = true
      if (active?.runtime === runtime) active = undefined
      runtime?.close()
      runtime = undefined
      await pending?.catch(() => {})
      await Promise.allSettled(pools.map((pool) => pool.end({ timeout: 3 })))
      pools = []
    },
  }
}
