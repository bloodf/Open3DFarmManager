import postgres from 'postgres'
import { createError, useRuntimeConfig } from 'nuxt/server'
import { PostgresPrinterOwnership } from '../../storage/postgres-printer-ownership.ts'
import { PostgresPrinterAssignmentInventory } from '../../storage/postgres-printer-assignment-inventory.ts'
import { validatePrinterAssignmentRole } from './role-policy.ts'
export interface PrinterAssignmentsRuntime {
  ownership: Pick<PostgresPrinterOwnership, 'register' | 'revoke'>
  inventory: Pick<PostgresPrinterAssignmentInventory, 'list'>
}
let instance: Promise<PrinterAssignmentsRuntime> | undefined
let pool: ReturnType<typeof postgres> | undefined
export function printerAssignmentsRuntime(): Promise<PrinterAssignmentsRuntime> {
  const raw: unknown = useRuntimeConfig()['printerAssignments']
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('enabled' in raw) ||
    raw.enabled !== true
  )
    throw createError({
      status: 404,
      message: 'Cadastro de impressoras indisponível.',
    })
  if (instance) return instance
  instance = (async () => {
    if (
      !('databaseUrl' in raw) ||
      typeof raw.databaseUrl !== 'string' ||
      raw.databaseUrl.length > 2048
    )
      throw new Error('Invalid configuration')
    const url = new URL(raw.databaseUrl)
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2
    )
      throw new Error('Invalid configuration')
    const sql = postgres(url.toString(), {
      max: 3,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 2000,
        lock_timeout: 1000,
        search_path: 'pg_catalog',
      },
    })
    pool = sql
    await validatePrinterAssignmentRole(sql)
    return {
      ownership: new PostgresPrinterOwnership(sql),
      inventory: new PostgresPrinterAssignmentInventory(sql),
    }
  })().catch(async () => {
    await closePrinterAssignmentsRuntime().catch(() => {})
    throw createError({
      status: 503,
      message: 'Cadastro de impressoras indisponível.',
    })
  })
  return instance
}
export async function closePrinterAssignmentsRuntime() {
  const closing = pool
  pool = undefined
  instance = undefined
  await closing?.end({ timeout: 3 })
}
