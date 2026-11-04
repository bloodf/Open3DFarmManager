import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

const MAX_PAGE_BYTES = 256 * 1024
const MAX_OFFSET = 10_000
const id = z.number().int().positive()
const text = z
  .string()
  .max(256)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    'Control characters are not allowed',
  )
const optionalText = text.nullish().transform((value) => value ?? null)
const weight = z
  .number()
  .finite()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? null)
const extra = z
  .unknown()
  .refine((value) => {
    if (value === null || value === undefined) return true
    if (typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Object.keys(value)
    return (
      keys.length <= 32 &&
      !keys.some((key) =>
        ['__proto__', 'constructor', 'prototype'].includes(key),
      )
    )
  }, 'Invalid extra fields')
  .pipe(
    z
      .record(z.string().min(1).max(64), z.string().max(4096))
      .nullish()
      .transform((value) => value ?? {}),
  )
  .default({})
export const SpoolmanVendor = z.object({ id, name: optionalText, extra })
export const SpoolmanFilament = z.object({
  id,
  name: optionalText,
  material: optionalText,
  vendor: SpoolmanVendor.nullish().transform((value) => value ?? null),
  density: z
    .number()
    .finite()
    .positive()
    .nullish()
    .transform((value) => value ?? null),
  diameter: z
    .number()
    .finite()
    .positive()
    .nullish()
    .transform((value) => value ?? null),
  weight,
  spool_weight: weight,
  color_hex: z
    .string()
    .regex(/^(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
    .nullish()
    .transform((value) => value ?? null),
  extra,
})
export const SpoolmanSpool = z.object({
  id,
  filament: SpoolmanFilament,
  initial_weight: weight,
  spool_weight: weight,
  used_weight: weight,
  // Negative remaining weight is preserved; never fabricate availability by clamping.
  remaining_weight: z
    .number()
    .finite()
    .nullish()
    .transform((value) => value ?? null),
  location: optionalText,
  lot_nr: optionalText,
  archived: z.boolean(),
  extra,
})
const contextSchema = z.strictObject({
  farmId: z.string().uuid(),
  serviceId: z.string().uuid(),
  observedAt: z.number().int().nonnegative(),
  offset: z.number().int().min(0).max(MAX_OFFSET),
  limit: z.number().int().min(1).max(200),
})
export type SpoolmanPageContext = z.infer<typeof contextSchema>
type Entity =
  | z.infer<typeof SpoolmanVendor>
  | z.infer<typeof SpoolmanFilament>
  | z.infer<typeof SpoolmanSpool>
export interface SpoolmanPage<T extends Entity> {
  farmId: string
  serviceId: string
  observedAt: number
  offset: number
  nextOffset: number | null
  items: T[]
}
export type SpoolmanReadErrorCode =
  | 'invalid-context'
  | 'frame-too-large'
  | 'invalid-frame'
  | 'invalid-page'
  | 'duplicate-id'
  | 'pagination-limit'
export class SpoolmanReadError extends Error {
  readonly code: SpoolmanReadErrorCode
  constructor(code: SpoolmanReadErrorCode) {
    super(`Spoolman page rejected: ${code}`)
    this.name = 'SpoolmanReadError'
    this.code = code
  }
}
function parsePage<T extends Entity>(
  wire: string,
  input: SpoolmanPageContext,
  schema: z.ZodType<T>,
): SpoolmanPage<T> {
  const context = contextSchema.safeParse(input)
  if (!context.success) throw new SpoolmanReadError('invalid-context')
  if (typeof wire !== 'string') throw new SpoolmanReadError('invalid-frame')
  if (Buffer.byteLength(wire, 'utf8') > MAX_PAGE_BYTES)
    throw new SpoolmanReadError('frame-too-large')
  let decoded: unknown
  try {
    decoded = parseBoundedJson(wire, {
      maxBytes: MAX_PAGE_BYTES,
      maxDepth: 12,
      maxValues: 20000,
      maxStringChars: 4096,
    })
  } catch {
    throw new SpoolmanReadError('invalid-frame')
  }
  // Empty strings in upstream extra fields stay opaque; no recursive JSON evaluation.
  const parsed = z.array(schema).max(context.data.limit).safeParse(decoded)
  if (!parsed.success) throw new SpoolmanReadError('invalid-page')
  const items = parsed.data
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new SpoolmanReadError('duplicate-id')
  const nextOffset =
    items.length === context.data.limit
      ? context.data.offset + items.length
      : null
  if (nextOffset !== null && nextOffset > MAX_OFFSET)
    throw new SpoolmanReadError('pagination-limit')
  return {
    farmId: context.data.farmId,
    serviceId: context.data.serviceId,
    observedAt: context.data.observedAt,
    offset: context.data.offset,
    nextOffset,
    items,
  }
}
export const parseSpoolmanVendors = (
  wire: string,
  context: SpoolmanPageContext,
) => parsePage(wire, context, SpoolmanVendor)
export const parseSpoolmanFilaments = (
  wire: string,
  context: SpoolmanPageContext,
) => parsePage(wire, context, SpoolmanFilament)
export const parseSpoolmanSpools = (
  wire: string,
  context: SpoolmanPageContext,
) => parsePage(wire, context, SpoolmanSpool)
