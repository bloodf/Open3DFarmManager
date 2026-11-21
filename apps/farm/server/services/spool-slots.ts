import type { SpoolSlotKind } from '../storage/spool-features-types.ts'
import { PostgresSpoolSlots } from '../storage/postgres-spool-slots.ts'
import type { Sql } from 'postgres'
import { spoolFeaturesSql } from './spool-drying.ts'

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
/** The validated `spoolFeatures` login: migration 0089 grants slot privileges only to it. */
export async function spoolSlotsRuntime(): Promise<SpoolSlotsRuntime> {
  return { sql: await spoolFeaturesSql() }
}
