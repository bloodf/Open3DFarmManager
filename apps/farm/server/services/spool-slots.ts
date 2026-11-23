import type { Sql } from 'postgres'
import { spoolFeaturesSql } from './spool-drying.ts'

export interface SpoolSlotsRuntime {
  sql: Sql
}
/** The validated `spoolFeatures` login: migration 0089 grants slot privileges only to it. */
export async function spoolSlotsRuntime(): Promise<SpoolSlotsRuntime> {
  return { sql: await spoolFeaturesSql() }
}
