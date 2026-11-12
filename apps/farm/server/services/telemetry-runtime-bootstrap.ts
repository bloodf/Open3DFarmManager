import postgres from 'postgres'
import {
  activateTelemetryHttpRuntime,
  deactivateTelemetryHttpRuntime,
} from './telemetry-http-runtime.ts'
import { parseTelemetryRuntimeConfig } from './telemetry-runtime-config.ts'

/** A future Node startup hook owns one instance and closes it during shutdown. */
export function createTelemetryRuntimeLifecycle() {
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
        await activateTelemetryHttpRuntime({
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
      } catch {
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
  /** A database that is unreachable at boot must not disable telemetry until a restart. */
  async function startUntilAvailable(
    input: unknown,
    delays = { minMs: 1000, maxMs: 30000 },
  ): Promise<Awaited<ReturnType<typeof start>>> {
    let delay = delays.minMs
    for (;;) {
      const result = await start(input)
      if (result !== 'unavailable' || closing) return result
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay)
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
