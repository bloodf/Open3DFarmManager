import { z } from 'zod'
import {
  parseGcodeMetadata,
  readGcodeMetadata,
  type GcodeByteSource,
} from './gcode-meta.ts'
import type { PrintFileMetadata as GcodeMetadata } from './schema.ts'

const ToolMetadata = z.object({
  nozzleDiameter: z.number().positive().optional(),
  filamentType: z.string().optional(),
  filamentColour: z.string().optional(),
  filamentGrams: z.number().nonnegative().optional(),
})

export const PrintFileMetadata = z.object({
  slicer: z.string().optional(),
  slicerVersion: z.string().optional(),
  printerModel: z.string().optional(),
  printerProfile: z.string().optional(),
  printProfile: z.string().optional(),
  filamentProfile: z.string().optional(),
  tools: z.array(ToolMetadata).optional(),
  layerHeight: z.number().positive().optional(),
  firstLayerHeight: z.number().positive().optional(),
  objectCount: z.number().int().nonnegative().optional(),
  bedSize: z.array(z.number()).optional(),
  estimatedTimeSeconds: z.number().nonnegative().optional(),
  totalLayers: z.number().int().nonnegative().optional(),
  thumbnail: z
    .object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string() })
    .optional(),
})
export type PrintFileMetadata = z.infer<typeof PrintFileMetadata>

/**
 * Library-side alias: the flat shape stored with library versions and read by
 * checkCompatibility. G-code parsing itself is owned by gcode-meta.ts (schema.ts
 * shape); fromGcodeMetadata maps one onto the other.
 */
export type LibraryFileMetadata = PrintFileMetadata

/** The library shows Bambu's slicer by the name its 3MF projects carry. */
const librarySlicerName = (name: string): string =>
  name === 'BambuStudio' ? 'Bambu Studio' : name

/**
 * Maps the published G-code metadata (schema.ts) onto the stored library
 * shape. Colours are stored as lower-case hex (compatibility compares them
 * case-insensitively).
 */
export function fromGcodeMetadata(meta: GcodeMetadata): PrintFileMetadata {
  const tools: NonNullable<PrintFileMetadata['tools']> = []
  for (const tool of meta.tools) {
    while (tools.length < tool.index) tools.push({})
    tools[tool.index] = {
      ...(tool.nozzleDiameterMm !== undefined && {
        nozzleDiameter: tool.nozzleDiameterMm,
      }),
      ...(tool.filamentType && { filamentType: tool.filamentType }),
      ...(tool.colour && { filamentColour: tool.colour.toLowerCase() }),
      ...(tool.grams !== undefined && { filamentGrams: tool.grams }),
    }
  }
  const filamentProfile = meta.tools.find((t) => t.filamentProfile)
    ?.filamentProfile
  return {
    ...(meta.slicer && { slicer: librarySlicerName(meta.slicer.name) }),
    ...(meta.slicer?.version && { slicerVersion: meta.slicer.version }),
    ...(meta.printerModel && { printerModel: meta.printerModel }),
    ...(meta.printerProfile && { printerProfile: meta.printerProfile }),
    ...(meta.printProfile && { printProfile: meta.printProfile }),
    ...(filamentProfile && { filamentProfile }),
    ...(tools.length && { tools }),
    ...(meta.layerHeightMm !== undefined && {
      layerHeight: meta.layerHeightMm,
    }),
    ...(meta.firstLayerHeightMm !== undefined && {
      firstLayerHeight: meta.firstLayerHeightMm,
    }),
    ...(meta.objectCount !== undefined && { objectCount: meta.objectCount }),
    ...(meta.bedSizeMm && { bedSize: [meta.bedSizeMm.x, meta.bedSizeMm.y] }),
    ...(meta.estimatedTimeSeconds !== undefined && {
      estimatedTimeSeconds: meta.estimatedTimeSeconds,
    }),
    ...(meta.totalLayers !== undefined && { totalLayers: meta.totalLayers }),
    ...(meta.thumbnail && {
      thumbnail: {
        mimeType:
          meta.thumbnail.format === 'png'
            ? ('image/png' as const)
            : ('image/jpeg' as const),
        data: meta.thumbnail.dataBase64,
      },
    }),
  }
}

/** Reads a G-code source with readGcodeMetadata and returns the library shape. */
export async function readLibraryGcodeMetadata(
  source: GcodeByteSource,
): Promise<PrintFileMetadata> {
  return fromGcodeMetadata(await readGcodeMetadata(source))
}

/** Parses bounded G-code header/footer text into the library shape. */
export function parseGcodeMetadataText(text: string): PrintFileMetadata {
  return fromGcodeMetadata(parseGcodeMetadata(text))
}
