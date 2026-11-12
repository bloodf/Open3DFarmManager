import postgres from 'postgres'
import {
  activateTelemetryHttpRuntime,
  deactivateTelemetryHttpRuntime,
} from './telemetry-http-runtime.ts'
import { parseTelemetryRuntimeConfig } from './telemetry-runtime-config.ts'

export type TelemetryStartupFailure = 'database-unreachable' | 'rejected'
const TRANSIENT = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '57014', // query_canceled (statement timeout while the database recovers)
])
/** Fixed classes only: never exposes error text, URLs or credentials. */
export function classifyTelemetryStartupFailure(
  error: unknown,
): TelemetryStartupFailure {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
  return TRANSIENT.has(code) || code.startsWith('08')
    ? 'database-unreachable'
    : 'rejected'
}

/** A future Node startup hook owns one instance and closes it during shutdown. */
export function createTelemetryRuntimeLifecycle(
  deps: {
    activate?: typeof activateTelemetryHttpRuntime
    onFailure?: (reason: TelemetryStartupFailure) => void
  } = {},
) {
  const activate = deps.activate ?? activateTelemetryHttpRuntime
  let lastFailure: TelemetryStartupFailure | undefined
  let pool: ReturnType<typeof postgres> | undefined
  let pending: Promise<'enabled' | 'unavailable'> | undefined
  let installed = false
  let closing = false
  async function start(
    input: unknown,
  ): Promise<'disabled' | 'invalid' | 'enabled' | 'unavailable'> {
    const parsed = parseTelemetryRuntimeConfig(input)
    if (parsed.kind !== 'enabled') return parsed.kind
    if (closing) return 'unavailable'
    if (installed) return 'enabled'
    if (pending) return pending
    pending = (async () => {
      const config = parsed.config
      const sql = postgres(config.databaseUrl, {
        max: 3,
        connect_timeout: 3,
        idle_timeout: 20,
        connection: { statement_timeout: 2000, lock_timeout: 1000 },
      })
      try {
        await activate({
          sql,
          keyFile: config.publicKeyRegistryPath,
          config: {
            origin: config.origin,
            issuer: config.issuer,
            audience: config.audience,
            ttlSeconds: config.tokenTtlSeconds,
            proofTtlMs: config.proofTtlMs,
          },
          bodyTimeoutMs: config.bodyTimeoutMs,
        })
        pool = sql
        installed = true
        return 'enabled'
      } catch (error) {
        const reason = classifyTelemetryStartupFailure(error)
        if (reason !== lastFailure) deps.onFailure?.(reason)
        lastFailure = reason
        await sql.end({ timeout: 3 })
        return 'unavailable'
      }
    })()
    try {
      return await pending
    } finally {
      pending = undefined
    }
  }
  let wake: (() => void) | undefined
  /**
   * A database that is unreachable at boot must not disable telemetry until a
   * restart. A rejected configuration (role, keys) retries only at the maximum delay.
   */
  async function startUntilAvailable(
    input: unknown,
    delays = { minMs: 1000, maxMs: 30000 },
  ): Promise<Awaited<ReturnType<typeof start>>> {
    let delay = delays.minMs
    for (;;) {
      const result = await start(input)
      if (result !== 'unavailable' || closing) return result
      if (lastFailure === 'rejected') delay = delays.maxMs
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
        timer.unref()
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = undefined
      delay = Math.min(delay * 2, delays.maxMs)
    }
  }
  async function close(): Promise<void> {
    closing = true
    wake?.()
    await pending
    if (installed) {
      deactivateTelemetryHttpRuntime()
      installed = false
    }
    const sql = pool
    pool = undefined
    if (sql) await sql.end({ timeout: 3 })
  }
  return { start, startUntilAvailable, close }
}
