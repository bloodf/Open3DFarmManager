import postgres from 'postgres'
import { useRuntimeConfig } from 'nuxt/server'
import { PostgresIntegrationApps } from '../storage/integration-apps-postgres.ts'
import {
  IntegrationAuth,
  parseIntegrationTokenConfig,
} from './integration-auth.ts'

let active:
  { pool: ReturnType<typeof postgres>; auth: IntegrationAuth } | undefined

export function integrationAuthConfigured() {
  const config: unknown = useRuntimeConfig().integrationAuth
  return (
    typeof config === 'object' &&
    config !== null &&
    'enabled' in config &&
    config.enabled === true
  )
}

function integrationRuntime() {
  if (active) return active
  const config = useRuntimeConfig().integrationAuth
  if (!integrationAuthConfigured())
    throw new Error('Autenticação de integrações indisponível.')
  if (
    typeof config !== 'object' ||
    config === null ||
    !('signingKey' in config) ||
    !('tokenTtlSeconds' in config) ||
    !('databaseUrl' in config) ||
    typeof config.databaseUrl !== 'string'
  )
    throw new Error('Configuração de autenticação de integrações inválida.')
  const token = parseIntegrationTokenConfig(config)
  const url = new URL(config.databaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2
  )
    throw new Error('Configuração de autenticação de integrações inválida.')
  const pool = postgres(url.toString(), {
    max: 3,
    connect_timeout: 3,
    idle_timeout: 20,
    onnotice: () => {},
    connection: {
      statement_timeout: 2000,
      lock_timeout: 1000,
      search_path: 'pg_catalog',
    },
  })
  const auth = new IntegrationAuth(new PostgresIntegrationApps(pool), token)
  active = { pool, auth }
  return active
}

export function integrationAuthRuntime() {
  return integrationRuntime().auth
}

export function integrationAuthPool() {
  return integrationRuntime().pool
}

export async function closeIntegrationAuthRuntime() {
  const closing = active
  active = undefined
  await closing?.pool.end({ timeout: 3 })
}
