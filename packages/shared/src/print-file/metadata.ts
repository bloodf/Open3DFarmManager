import { z } from 'zod'

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
