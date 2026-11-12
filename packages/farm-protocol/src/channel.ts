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

/** Browser-side parse. Printer and safety fields stay strict; an invalid or
 * unknown-shaped inventory is dropped so printer status keeps flowing.
 */
export function parseStatusMessageTolerant(value: unknown) {
  const strict = StatusMessage.safeParse(value)
  if (
    strict.success ||
    typeof value !== 'object' ||
    value === null ||
    !('inventory' in value)
  )
    return strict
  const { inventory: _dropped, ...rest } = value
  const withoutInventory = StatusMessage.safeParse(rest)
  return withoutInventory.success ? withoutInventory : strict
}
