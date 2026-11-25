import { z } from 'zod'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
  readPrivateJsonFile,
} from './local.ts'

export const CrealityBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  /** Legacy WebSocket port; secure transport is decided at connect time. */
  port: z.number().int().min(1).max(65535).default(9999),
  transport: z.enum(['ws', 'wss']).optional(),
  httpsPort: z.number().int().min(1).max(65535).optional(),
  caFile: z.string().min(1).max(4096).optional(),
  /** Stock HTTP upload port (POST /upload/<name>); absent means 80. */
  httpPort: z.number().int().min(1).max(65535).optional(),
  /**
   * Owner opt-in for CFS load and unload, off by default: it heats and moves
   * filament and has not been run on a printer.
   */
  cfsFeed: z.boolean().optional(),
})
export function crealityWebUiOrigin(binding: {
  host: string
  httpPort?: number | undefined
}): string {
  const host = binding.host.includes(':') ? `[${binding.host}]` : binding.host
  const port = binding.httpPort ?? 80
  return `http://${host}${port === 80 ? '' : `:${port}`}`
}
const CrealityConfig = LocalCollectorConfigSchema.options[0]
  .omit({ bambu: true })
  .extend({
    version: z.literal(4),
    creality: z.strictObject({
      printers: z.array(CrealityBinding).min(1).max(16),
    }),
  })
export type CrealityCollectorConfig = z.infer<typeof CrealityConfig>

export function parseCollectorConfig(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    input.version !== 4
  )
    return parseLocalCollectorConfig(input)
  const config = CrealityConfig.parse(input)
  // Reuse all Moonraker validation without relaxing the legacy schemas.
  if (config.printers.length)
    parseLocalCollectorConfig({
      version: 1,
      allowedOrigins: config.allowedOrigins,
      printers: config.printers,
      limits: config.limits,
      ...(config.spoolman ? { spoolman: config.spoolman } : {}),
    })
  const keys = new Set(config.printers.map((printer) => printer.printerKey))
  const endpoints = new Set<string>()
  if (config.printers.length + config.creality.printers.length > 16)
    throw Error('Collector capacity exceeded')
  for (const binding of config.creality.printers) {
    const endpoint = JSON.stringify([binding.host.toLowerCase(), binding.port])
    if (keys.has(binding.printerKey) || endpoints.has(endpoint))
      throw Error('Duplicate collector target')
    keys.add(binding.printerKey)
    endpoints.add(endpoint)
  }
  return config
}

export function readCollectorConfig(path: string) {
  return parseCollectorConfig(readPrivateJsonFile(path, { maxBytes: 65536 }))
}
