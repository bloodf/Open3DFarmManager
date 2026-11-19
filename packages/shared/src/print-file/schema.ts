import { z } from 'zod'

/** Largest decoded thumbnail kept in a result (256 KiB). */
export const MAX_THUMBNAIL_BYTES = 256 * 1024
/** Base64 length of a MAX_THUMBNAIL_BYTES payload (no whitespace). */
export const MAX_THUMBNAIL_BASE64_CHARS = Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4
export const MAX_TOOLS = 32
export const MAX_TEXT = 256

const text = z.string().min(1).max(MAX_TEXT)

export const PrintFileThumbnail = z.object({
  format: z.enum(['png', 'jpg']),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  sizeBytes: z.number().int().positive().max(MAX_THUMBNAIL_BYTES),
  dataBase64: z.string().min(1).max(MAX_THUMBNAIL_BASE64_CHARS),
})

export const PrintFileTool = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_TOOLS - 1),
  nozzleDiameterMm: z.number().positive().max(10).optional(),
  filamentType: text.optional(),
  /** `#RRGGBB` or `#RRGGBBAA`, upper-cased. */
  colour: z
    .string()
    .regex(/^#[0-9A-F]{6}([0-9A-F]{2})?$/)
    .optional(),
  grams: z.number().nonnegative().max(1_000_000).optional(),
  filamentProfile: text.optional(),
})

/** Metadata read from a G-code file; every field is optional, `{ tools: [] }` is the empty result. */
export const PrintFileMetadata = z.object({
  slicer: z.object({ name: text, version: text.optional() }).optional(),
  printerModel: text.optional(),
  printerProfile: text.optional(),
  printProfile: text.optional(),
  tools: z.array(PrintFileTool).max(MAX_TOOLS).default([]),
  layerHeightMm: z.number().positive().max(10).optional(),
  firstLayerHeightMm: z.number().positive().max(10).optional(),
  objectCount: z.number().int().nonnegative().max(100_000).optional(),
  bedSizeMm: z
    .object({
      x: z.number().positive().max(100_000),
      y: z.number().positive().max(100_000),
    })
    .optional(),
  estimatedTimeSeconds: z.number().nonnegative().max(31_536_000).optional(),
  totalLayers: z.number().int().nonnegative().max(10_000_000).optional(),
  /** Largest embedded PNG/JPG thumbnail that fits MAX_THUMBNAIL_BYTES. */
  thumbnail: PrintFileThumbnail.optional(),
})

export type PrintFileThumbnail = z.infer<typeof PrintFileThumbnail>
export type PrintFileTool = z.infer<typeof PrintFileTool>
export type PrintFileMetadata = z.infer<typeof PrintFileMetadata>
