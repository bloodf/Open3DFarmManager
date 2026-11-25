import { z } from 'zod'
import { resinLedgerEntry } from './entry.ts'

const uuid = z.uuid()
const printerKey = z.string().min(1).max(128)

export const resinLedgerListQuery = z.strictObject({
  farmId: uuid,
  printerKey,
})
/**
 * Browser writes are manual by construction: `reported` readings come only
 * from the Connector, so an account can never claim reported provenance.
 */
export const resinLedgerRecordBody = z.strictObject({
  farmId: uuid,
  printerKey,
  entry: resinLedgerEntry.refine((entry) => entry.source === 'manual'),
})
