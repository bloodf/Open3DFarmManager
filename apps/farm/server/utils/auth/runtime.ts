import postgres from 'postgres'
import { createError, useRuntimeConfig, type SessionConfig } from 'nuxt/server'
import type { SessionRepository } from './session-contract.ts'
import { PostgresSessionRepository } from '../../storage/postgres-session.ts'
import { PostgresCredentials } from '../../storage/postgres-credentials.ts'
import {
  configuredAuthOrigin,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from './boundary.ts'

export interface AuthRuntime {
  origin: string
  cookie: SessionConfig
  sessions: SessionRepository
  credentials: Pick<PostgresCredentials, 'consumeLimit' | 'find' | 'issue'>
  idleTimeoutMs: number
  lifetimeMs: number
}
let instance: AuthRuntime | undefined
let closePool: (() => Promise<void>) | undefined
export function authRuntime(): AuthRuntime {
  const config: unknown = useRuntimeConfig().auth
  if (
    typeof config !== 'object' ||
    config === null ||
    !('enabled' in config) ||
    config.enabled !== true
  )
    throw createError({ status: 404, message: 'Recurso indisponível.' })
  if (instance) return instance
  try {
    if (
      !('origin' in config) ||
      typeof config.origin !== 'string' ||
      !('sessionSecret' in config) ||
      !('databaseUrl' in config) ||
      typeof config.databaseUrl !== 'string'
    )
      throw new Error()
    const origin = configuredAuthOrigin(config.origin)
    const secret = config.sessionSecret
    if (typeof secret !== 'string' || secret.length < 32) throw new Error()
    const databaseURL = new URL(config.databaseUrl)
    if (!['postgres:', 'postgresql:'].includes(databaseURL.protocol))
      throw new Error()
    const sql = postgres(databaseURL.toString(), {
      max: 6,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: { statement_timeout: 2000, lock_timeout: 1000 },
    })
    closePool = async () => {
      await sql.end({ timeout: 3 })
    }
    instance = {
      origin,
      cookie: {
        name: SESSION_COOKIE_NAME,
        password: secret,
        maxAge: 8 * 60 * 60,
        cookie: { ...SESSION_COOKIE_ATTRIBUTES },
      },
      sessions: new PostgresSessionRepository(sql),
      credentials: new PostgresCredentials(sql),
      idleTimeoutMs: 30 * 60 * 1000,
      lifetimeMs: 8 * 60 * 60 * 1000,
    }
    return instance
  } catch {
    throw createError({ status: 503, message: 'Autenticação indisponível.' })
  }
}
export async function closeAuthRuntime(): Promise<void> {
  await closePool?.()
  instance = undefined
  closePool = undefined
}
