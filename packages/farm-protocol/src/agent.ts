import { z } from 'zod'
import { PrinterState } from './state.ts'

export const AgentSync = z.strictObject({
  agents_seq: z.number().int().nonnegative(),
  printers: z.array(PrinterState).max(100),
  queue_depth: z.number().int().nonnegative(),
})
// Deliberately carries no command field: HTTP is persistence only.
export const AgentSyncResponse = z.strictObject({
  snapshot_cadence_s: z.number().int().min(120).max(3600),
})
export type AgentSync = z.infer<typeof AgentSync>
