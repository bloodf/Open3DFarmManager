import postgres, { type Sql } from 'postgres'
import { z } from 'zod'
import { PostgresPauseNegotiation } from '../../storage/postgres-pause-negotiation.ts'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PairingProofOrigin } from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import { createPauseAuthorityService } from '../../services/pause-authority.ts'
import type { PauseAuthorityHttpRuntime } from '../../services/pause-authority-http.ts'
import type { AuthRuntime } from '../auth/runtime.ts'
import {
  parsePauseAuthorityRuntimeConfig,
  type PauseAuthorityRuntimeConfig,
} from './config.ts'
import { loadPauseIssuerKey } from './issuer-key.ts'
import { validatePauseAuthorityRole } from './role-policy.ts'

export type PauseNegotiationRuntime = Readonly<{
  owner: object
  signal: AbortSignal
  origin: string
  audience: string
  credentialIssuer: string
  credentialAudience: string
  databaseIdentity: Readonly<{
    database: string
    address: string | null
    port: number | null
  }>
  reader: Readonly<Pick<PostgresPauseNegotiation, 'read'>>
}>
const DatabaseIdentity = z.strictObject({
  database: z.string().min(1).max(63),
  address: z.string().min(1).max(64).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
})
let owner: object | undefined
let active:
  | Readonly<{
      owner: object
      runtime: PauseAuthorityHttpRuntime
      negotiation: PauseNegotiationRuntime
    }>
  | undefined
/** Internal publication only: configuration flags alone never provide a reader. */
export function currentPauseNegotiationRuntime():
  | PauseNegotiationRuntime
  | undefined {
  return active?.negotiation
}
export function pauseAuthorityRuntime(): PauseAuthorityHttpRuntime {
  const raw: unknown = Reflect.get(useRuntimeConfig(), 'pauseAuthority')
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({
      status: 404,
      message: 'Autorização de pausa indisponível.',
    })
  if (!active)
    throw createError({
      status: 503,
      message: 'Autorização de pausa indisponível. Tente novamente.',
    })
  return active.runtime
}

/** Reserve one startup, publish only after validation, retain ownership until pending cleanup settles. */
export function createPauseAuthorityRuntimeLifecycle() {
  const identity = Object.freeze({})
  const terminal = new AbortController()
  let pending: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let pool: Sql | undefined
  let service: ReturnType<typeof createPauseAuthorityService> | undefined
  let closed = false
  let cleanupFailure: Error | undefined
  async function releasePool(): Promise<void> {
    const owned = pool
    pool = undefined
    try {
      await owned?.end({ timeout: 3 })
    } catch {
      cleanupFailure = new Error('Pause authority database cleanup failed')
      throw cleanupFailure
    }
  }
  return Object.freeze({
    start(
      input: PauseAuthorityRuntimeConfig,
      auth: AuthRuntime,
    ): Promise<void> {
      if (closed || pending || owner)
        throw new Error('Pause authority lifecycle unavailable')
      const config = parsePauseAuthorityRuntimeConfig(input)
      if (!config)
        throw new Error('Pause authority requires enabled configuration')
      const origin = PairingProofOrigin.parse(auth.origin)
      if (!origin.startsWith('https://') || auth.idleTimeoutMs !== 1800000)
        throw new Error('Invalid pause authority login configuration')
      owner = identity
      pending = (async () => {
        try {
          const keys = await loadPauseIssuerKey(config.issuerKeyPath, {
            issuer: config.issuer,
            kid: config.kid,
            publicKeySpki: config.issuerPublicKeySpki,
          })
          if (closed) throw new Error('Pause authority startup cancelled')
          const sql = postgres(config.databaseUrl, {
            max: 4,
            connect_timeout: 3,
            idle_timeout: 20,
            connection: {
              statement_timeout: 2000,
              lock_timeout: 1000,
              transaction_timeout: 10000,
              search_path: 'pg_catalog',
              options: '-c role=farm_pause_authority',
            },
          })
          pool = sql
          if (closed) throw new Error('Pause authority startup cancelled')
          await validatePauseAuthorityRole(sql)
          if (closed || owner !== identity)
            throw new Error('Pause authority startup cancelled')
          const rows = await sql`
            SELECT current_database()::text AS database,
              inet_server_addr()::text AS address, inet_server_port() AS port`
          if (closed || owner !== identity || rows.length !== 1)
            throw new Error('Pause authority startup cancelled')
          const databaseIdentity = Object.freeze(
            DatabaseIdentity.parse(rows[0]),
          )
          const reader = new PostgresPauseNegotiation(sql, {
            origin,
            audience: config.audience,
            credentialIssuer: config.credentialIssuer,
            credentialAudience: config.credentialAudience,
            idleTimeoutMs: 1800000,
          })
          const negotiation: PauseNegotiationRuntime = Object.freeze({
            owner: identity,
            signal: terminal.signal,
            origin,
            audience: config.audience,
            credentialIssuer: config.credentialIssuer,
            credentialAudience: config.credentialAudience,
            databaseIdentity,
            reader: Object.freeze({
              read: async (scope: unknown) => {
                if (closed || active?.owner !== identity) return null
                const result = await reader.read(scope)
                return closed || active?.owner !== identity ? null : result
              },
            }),
          })
          service = createPauseAuthorityService(sql, {
            origin,
            audience: config.audience,
            issuer: config.issuer,
            kid: config.kid,
            credentialIssuer: config.credentialIssuer,
            credentialAudience: config.credentialAudience,
            idleTimeoutMs: 1800000,
            ...keys,
          })
          if (closed) throw new Error('Pause authority startup cancelled')
          active = Object.freeze({
            owner: identity,
            negotiation,
            runtime: Object.freeze({ auth, authority: service }),
          })
        } catch {
          closed = true
          if (active?.owner === identity) active = undefined
          terminal.abort()
          service?.close()
          try {
            await releasePool()
          } finally {
            if (!cleanupFailure && owner === identity) owner = undefined
          }
          throw new Error('Pause authority startup unavailable')
        }
      })()
      return pending
    },
    close(): Promise<void> {
      if (closing) return closing
      let resolve!: () => void
      let reject!: (reason: unknown) => void
      closing = new Promise<void>((done, failed) => {
        resolve = done
        reject = failed
      })
      closed = true
      if (active?.owner === identity) active = undefined
      terminal.abort()
      service?.close()
      void (async () => {
        try {
          await pending?.catch(() => {})
          service?.close()
          await releasePool()
          if (cleanupFailure) throw cleanupFailure
        } finally {
          if (!cleanupFailure && owner === identity) owner = undefined
        }
      })().then(resolve, reject)
      return closing
    },
  })
}
