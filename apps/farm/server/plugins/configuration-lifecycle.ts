import postgres from 'postgres'
import { parseBoundedJson } from '../../../../packages/farm-protocol/src/json.ts'
import { useRuntimeConfig } from 'nuxt/server'
import { pathToFileURL } from 'node:url'
import { createPublicKey } from 'node:crypto'
import { loadMigrationCatalog } from '../../../../scripts/db/migrations.ts'
import { schemaState } from '../utils/database/schema.ts'
import {
  parseDatabaseRuntimeConfig,
  assertSameDatabaseTargets,
} from '../utils/database/runtime.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import { parseConfigurationRuntimeConfig } from '../utils/configuration/config.ts'
import { loadConfigurationIssuerKey } from '../utils/configuration/issuer-key.ts'
import { installConfigurationRuntime } from '../utils/configuration/runtime.ts'
import { PostgresConfigurationStore } from '../storage/postgres-configuration.ts'
import { PostgresConnectorCredentialAcceptance } from '../storage/postgres-connector-credential-acceptance.ts'
import { loadTelemetryVerificationKeys } from '../services/telemetry-key-registry.ts'
import { ConfigurationSignallingCoordinator } from '../services/configuration-signalling-coordinator.ts'
import { ConfigurationSignallingRuntime } from '../services/configuration-signalling-runtime.ts'
import { createConfigurationAuthorityService } from '../services/configuration-authority.ts'
import { createConfigurationRegistrationService } from '../services/configuration-receipt-registration.ts'

export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  const runtimeConfig = useRuntimeConfig()
  // Explicit private deployment input; Nuxt's manifest remains owned elsewhere.
  // No default key, URL or enabled flag is synthesized.
  const configured = process.env.OPEN3DFARM_CONFIGURATION
  const root =
    configured === undefined
      ? runtimeConfig
      : {
          ...runtimeConfig,
          configuration: parseBoundedJson(configured, {
            maxBytes: 16384,
            maxDepth: 2,
            maxValues: 32,
            maxStringChars: 2048,
          }),
        }
  const config = parseConfigurationRuntimeConfig(
    Reflect.get(root, 'configuration'),
  )
  if (!config) return
  const database = parseDatabaseRuntimeConfig(Reflect.get(root, 'database'))
  if (!database) throw new Error('Configuration requires database readiness')
  assertSameDatabaseTargets(database, root)
  const pause: unknown = Reflect.get(root, 'pauseAuthority')
  if (
    pause &&
    typeof pause === 'object' &&
    (Reflect.get(pause, 'issuerKeyPath') === config.issuerKeyPath ||
      Reflect.get(pause, 'issuerPublicKeySpki') === config.issuerPublicKeySpki)
  )
    throw new Error('Configuration requires a dedicated issuer key')
  const auth = authRuntime()
  if (!auth.origin.startsWith('https://') || auth.idleTimeoutMs !== 1800000)
    throw new Error('Configuration requires HTTPS login')
  let closed = false
  let uninstall: (() => void) | undefined
  let coordinator: ConfigurationSignallingCoordinator | undefined
  const options = {
    max: 3,
    connect_timeout: 3,
    idle_timeout: 20,
    connection: {
      statement_timeout: 2000,
      lock_timeout: 1000,
      transaction_timeout: 10000,
    },
  }
  const sql = postgres(config.databaseUrl, options)
  const proof = postgres(config.proofDatabaseUrl, options)
  const pending = (async () => {
    const catalog = await loadMigrationCatalog(
      pathToFileURL(`${database.migrationsDir.replace(/\/$/, '')}/`),
    )
    if ((await schemaState(sql, catalog)) !== 'current')
      throw new Error('Configuration schema unavailable')
    for (const [pool, role] of [
      [sql, 'farm_configuration_authority'],
      [proof, 'farm_connector_credential_acceptor'],
    ] as const) {
      const rows =
        await pool`SELECT pg_has_role(current_user,${role},'USAGE') AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolcreaterole OR r.rolbypassrls OR r.rolcreatedb OR r.rolreplication OR r.rolname NOT IN (current_user,${role}))) AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER')) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='farm' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS allowed`
      if (rows[0]?.allowed !== true)
        throw new Error('Configuration database role unavailable')
    }
    const identities = await Promise.all([
      sql`SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port`,
      proof`SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port`,
    ])
    if (JSON.stringify(identities[0]) !== JSON.stringify(identities[1]))
      throw new Error('Configuration database mismatch')
    const keys = await loadConfigurationIssuerKey(config.issuerKeyPath, {
      issuer: config.issuer,
      kid: config.kid,
      publicKeySpki: config.issuerPublicKeySpki,
    })
    const publicKeys = await loadTelemetryVerificationKeys(
      config.publicKeyRegistryPath,
    )
    const store = new PostgresConfigurationStore(sql, {
      origin: auth.origin,
      audience: config.audience,
      credentialIssuer: config.credentialIssuer,
      credentialAudience: config.credentialAudience,
      idleTimeoutMs: 1800000,
    })
    const credentials = new PostgresConnectorCredentialAcceptance(proof, {
      issuer: config.credentialIssuer,
      audience: config.credentialAudience,
      origin: auth.origin,
      purpose: 'signalling',
      publicKeys,
      ttlSeconds: config.tokenTtlSeconds,
      proofTtlMs: config.proofTtlMs,
    })
    coordinator = new ConfigurationSignallingCoordinator({
      authority: store,
      credentials,
      credentialAudience: config.credentialAudience,
      clock: { wall: Date.now, monotonic: () => performance.now() },
      timers: {
        after(ms, callback) {
          const timer = setTimeout(callback, ms)
          return () => clearTimeout(timer)
        },
      },
    })
    if (closed) {
      coordinator.dispose()
      return
    }
    const issuer = {
      issuer: config.issuer,
      kid: config.kid,
      privateKey: keys.signingKey,
    }
    uninstall = installConfigurationRuntime({
      http: {
        auth,
        authority: createConfigurationAuthorityService({
          store,
          registry: coordinator,
          issuer,
        }),
        registration: createConfigurationRegistrationService({
          store,
          registry: coordinator,
          issuer,
        }),
      },
      signalling: new ConfigurationSignallingRuntime({
        origin: auth.origin,
        cookie: auth.cookie,
        coordinator,
      }),
      issuer: {
        protocol: 'config-v1',
        issuerKid: config.kid,
        origin: auth.origin,
        audience: config.audience,
        publicKeyJwk: createPublicKey({
          key: Buffer.from(config.issuerPublicKeySpki, 'base64url'),
          format: 'der',
          type: 'spki',
        }).export({ format: 'jwk' }),
      },
    })
  })()
  const cleanup = async () => {
    closed = true
    uninstall?.()
    coordinator?.dispose()
    await Promise.all([sql.end({ timeout: 3 }), proof.end({ timeout: 3 })])
  }
  nitro.hooks.hook('close', async () => {
    closed = true
    await pending.catch(() => {})
    await cleanup()
  })
  void pending.catch(async () => {
    await cleanup()
    nitro.captureError(new Error('Configuration startup unavailable'), {
      tags: ['configuration-startup'],
    })
  })
})
