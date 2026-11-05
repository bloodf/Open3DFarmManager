import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PostgresConnectorInventory } from '../../storage/postgres-connector-inventory.ts'

let instance: PostgresConnectorInventory | undefined
let closePool: (() => Promise<void>) | undefined
export function connectorInventoryRuntime(): PostgresConnectorInventory {
  const config: unknown = useRuntimeConfig().connectorInventory
  if (
    typeof config !== 'object' ||
    config === null ||
    !('enabled' in config) ||
    config.enabled !== true
  )
    throw createError({ status: 404, message: 'Inventário indisponível.' })
  if (instance) return instance
  try {
    if (!('databaseUrl' in config) || typeof config.databaseUrl !== 'string')
      throw new Error()
    const url = new URL(config.databaseUrl)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error()
    const sql = postgres(url.toString(), {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: { statement_timeout: 2000, lock_timeout: 1000 },
    })
    closePool = () => sql.end({ timeout: 3 })
    instance = new PostgresConnectorInventory(sql)
    return instance
  } catch {
    throw createError({
      status: 503,
      message: 'Inventário indisponível. Tente novamente.',
    })
  }
}
export async function closeConnectorInventoryRuntime(): Promise<void> {
  await closePool?.()
  instance = undefined
  closePool = undefined
}
