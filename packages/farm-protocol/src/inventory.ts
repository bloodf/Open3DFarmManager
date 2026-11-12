import { z } from 'zod'

/** Read-only spool summary mirrored from Spoolman. Display evidence only. */
export const MAX_INVENTORY_SPOOLS = 8
export const SpoolSummary = z.strictObject({
  name: z.string().max(32).nullable(),
  material: z.string().max(16).nullable(),
  colorHex: z
    .string()
    .regex(/^[0-9a-f]{6}$/)
    .nullable(),
  // Grams. Negative values are preserved, never clamped into availability.
  remainingGrams: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
  location: z.string().max(32).nullable(),
  archived: z.boolean(),
})
export const SpoolInventory = z.strictObject({
  observedAt: z.number().int().nonnegative(),
  stale: z.boolean(),
  total: z.number().int().min(0).max(10_000),
  spools: z.array(SpoolSummary).max(MAX_INVENTORY_SPOOLS),
})
export type SpoolSummary = z.infer<typeof SpoolSummary>
export type SpoolInventory = z.infer<typeof SpoolInventory>
