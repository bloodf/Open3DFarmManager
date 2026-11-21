import type { SpoolSlotKind } from '../storage/spool-features-types.ts'
import { PostgresSpoolSlots } from '../storage/postgres-spool-slots.ts'
import type { Sql } from 'postgres'

export const activeSpoolForPrinterSlotAt = (
  sql: Sql,
  input: {
    farmId: string
    printerId: string
    slotKind: SpoolSlotKind
    slotIndex: number
    at: number
  },
) =>
  new PostgresSpoolSlots(sql).activeAt(
    input.farmId,
    input.printerId,
    input.slotKind,
    input.slotIndex,
    input.at,
  )

export interface SpoolSlotsRuntime {
  sql: Sql
}
let pool: Sql | undefined
export async function spoolSlotsRuntime(): Promise<SpoolSlotsRuntime> {
  if (!pool) {
    const { useRuntimeConfig } = await import('nuxt/server')
    const config = useRuntimeConfig() as Record<string, any>
    const url =
      config.spoolLibrary?.databaseUrl ?? config.spoolSlots?.databaseUrl
    if (!url) throw new Error('Spool slots storage unavailable')
    const postgres = (await import('postgres')).default
    pool = postgres(url, { max: 2, idle_timeout: 3, connect_timeout: 2 })
  }
  return { sql: pool }
}
