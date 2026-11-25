import { z } from 'zod'

const label = z.string().trim().min(1).max(128)
const quantity = z.number().finite().nonnegative()
const provenance = z.enum(['manual', 'reported'])

/** An entry carries only the reading actually supplied by its source. */
export const resinLedgerEntry = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('vat'), name: label, source: provenance }),
  z.strictObject({
    kind: z.literal('bottle'),
    name: label,
    volumeMl: quantity.nullable(),
    source: provenance,
  }),
  z.strictObject({
    kind: z.literal('volume'),
    target: z.enum(['vat', 'bottle']),
    name: label,
    volumeMl: quantity,
    source: provenance,
  }),
  z.strictObject({
    kind: z.literal('film'),
    layers: quantity.int().safe(),
    source: provenance,
  }),
  z.strictObject({
    kind: z.literal('lcd'),
    hours: quantity,
    source: provenance,
  }),
])
export type ResinLedgerEntry = z.infer<typeof resinLedgerEntry>
