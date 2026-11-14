import { z } from 'zod'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
  readPrivateJsonFile,
} from './local.ts'
import { parseCollectorConfig as parseLegacy } from './creality.ts'
export const AnycubicBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535).default(9883),
  modelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  username: z.string().min(1).max(256),
  passwordFile: z.string().min(1).max(4096),
})
const Config = LocalCollectorConfigSchema.options[0]
  .omit({ bambu: true })
  .extend({
    version: z.literal(5),
    anycubic: z.strictObject({
      printers: z.array(AnycubicBinding).min(1).max(16),
    }),
  })
export type AnycubicCollectorConfig = z.infer<typeof Config>
export function parseCollectorConfig(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    input.version !== 5
  )
    return parseLegacy(input)
  const config = Config.parse(input)
  if (config.printers.length)
    parseLocalCollectorConfig({
      version: 1,
      printers: config.printers,
      allowedOrigins: config.allowedOrigins,
      limits: config.limits,
      ...(config.spoolman ? { spoolman: config.spoolman } : {}),
    })
  const keys = new Set(config.printers.map((p) => p.printerKey))
  const endpoints = new Set<string>()
  if (config.printers.length + config.anycubic.printers.length > 16)
    throw Error('Collector capacity exceeded')
  for (const p of config.anycubic.printers) {
    const endpoint = JSON.stringify([
      p.host.toLowerCase(),
      p.port,
      p.modelId,
      p.deviceId,
    ])
    if (keys.has(p.printerKey) || endpoints.has(endpoint))
      throw Error('Duplicate collector target')
    keys.add(p.printerKey)
    endpoints.add(endpoint)
  }
  return config
}
export function readCollectorConfig(path: string) {
  return parseCollectorConfig(readPrivateJsonFile(path, { maxBytes: 65536 }))
}
