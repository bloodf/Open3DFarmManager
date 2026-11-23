import { z } from 'zod'
import { isLocalFormlabsHost } from './index.ts'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
} from '../config/local.ts'
import { parseCollectorConfig as parseLegacy } from '../config/sdcp.ts'

export const FormlabsBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  host: z.string().refine(isLocalFormlabsHost),
  port: z.number().int().min(1).max(65535),
  deviceId: z.string().min(1).max(128),
})
const Config = LocalCollectorConfigSchema.options[0]
  .omit({ bambu: true })
  .extend({
    version: z.literal(7),
    formlabs: z.strictObject({
      printers: z.array(FormlabsBinding).min(1).max(16),
    }),
  })
export type FormlabsCollectorConfig = z.infer<typeof Config>
export function parseCollectorConfig(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    input.version !== 7
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
  if (config.printers.length + config.formlabs.printers.length > 16)
    throw Error('Collector capacity exceeded')
  const keys = new Set(config.printers.map((p) => p.printerKey))
  const targets = new Set<string>()
  for (const printer of config.formlabs.printers) {
    const target = JSON.stringify([
      printer.host,
      printer.port,
      printer.deviceId,
    ])
    if (keys.has(printer.printerKey) || targets.has(target))
      throw Error('Duplicate collector target')
    keys.add(printer.printerKey)
    targets.add(target)
  }
  return config
}
