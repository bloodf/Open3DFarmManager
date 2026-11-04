import { z } from 'zod'
import { PrinterState } from './state.ts'

export const StatusMessage = z.strictObject({
  t: z.literal('snapshot'),
  seq: z.number().int().nonnegative(),
  printers: z.array(PrinterState).max(100),
})
export const CommandAck = z.strictObject({
  t: z.literal('ack'),
  cmd_id: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().max(256).optional(),
})
