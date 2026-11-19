import { z } from 'zod'
import type { PrinterState } from './state.ts'

/**
 * Spool assigned to a printer tool or AMS slot, when known.
 * Matches docs/api/openapi-v1.yaml `ActiveSpool`.
 */
export const ActiveSpool = z.strictObject({
  slot: z.string().min(1).max(32),
  name: z.string().max(32).optional(),
  material: z.string().max(64).optional(),
  colorHex: z
    .string()
    .regex(/^[0-9a-f]{6}$/)
    .optional(),
  remainingGrams: z.number().int().optional(),
  remainingPercent: z.number().min(0).max(100).optional(),
  spoolId: z.number().int().positive().optional(),
})
export type ActiveSpool = z.infer<typeof ActiveSpool>

/** Active spool per tool / AMS slot (max matches PrinterState materials). */
export const ActiveSpools = z.array(ActiveSpool).max(17)
export type ActiveSpools = z.infer<typeof ActiveSpools>

function colorFromMaterial(colorHex: string | undefined): string | undefined {
  if (!colorHex) return undefined
  const hex = colorHex.length === 8 ? colorHex.slice(0, 6) : colorHex
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? hex.toLowerCase() : undefined
}

/**
 * Projects live materials observations into the Integration / status schema.
 * Each material slot is one tool entry; `active` on the material is not required
 * because operators may assign a spool to every AMS tray.
 */
export function activeSpoolsFromMaterials(
  materials: NonNullable<PrinterState['materials']> | undefined,
): ActiveSpools | undefined {
  if (!materials?.length) return undefined
  const spools: ActiveSpool[] = []
  for (const entry of materials) {
    const colorHex = colorFromMaterial(entry.colorHex)
    const spool = ActiveSpool.parse({
      slot: entry.slot,
      ...(entry.materialType ? { material: entry.materialType } : {}),
      ...(colorHex ? { colorHex } : {}),
      ...(entry.remainingPercent !== undefined
        ? { remainingPercent: entry.remainingPercent }
        : {}),
    })
    spools.push(spool)
  }
  return ActiveSpools.parse(spools)
}
