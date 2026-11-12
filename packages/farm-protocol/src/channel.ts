import { z } from 'zod'
import { PrinterState } from './state.ts'
import { SpoolInventory } from './inventory.ts'

export const StatusMessage = z.strictObject({
  t: z.literal('snapshot'),
  seq: z.number().int().nonnegative(),
  printers: z.array(PrinterState).max(100),
  // Optional so snapshots from Connectors without Spoolman stay valid.
  inventory: SpoolInventory.optional(),
})
export const CommandAck = z.strictObject({
  t: z.literal('ack'),
  cmd_id: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().max(256).optional(),
})
