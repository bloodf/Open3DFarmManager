import { z } from 'zod'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
  readPrivateJsonFile,
} from './local.ts'
import { parseCollectorConfig as parseLegacy } from './anycubic.ts'
import { isSupportedSdcpModel } from '../discovery/sdcp.ts'

export const SdcpBinding = z.strictObject({
  printerKey: z.string().min(1).max(128),
  host: z.ipv4(),
  mainboardId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  model: z.string().min(1).max(128).refine(isSupportedSdcpModel),
})
const Config = LocalCollectorConfigSchema.options[0]
  .omit({ bambu: true })
  .extend({
    version: z.literal(6),
    sdcp: z.strictObject({ printers: z.array(SdcpBinding).min(1).max(16) }),
  })
export type SdcpCollectorConfig = z.infer<typeof Config>
export function parseCollectorConfig(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    input.version !== 6
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
  if (config.printers.length + config.sdcp.printers.length > 16)
    throw Error('Collector capacity exceeded')
  const keys = new Set(config.printers.map((p) => p.printerKey))
  const hosts = new Set<string>()
  const ids = new Set<string>()
  for (const p of config.sdcp.printers) {
    if (keys.has(p.printerKey) || hosts.has(p.host) || ids.has(p.mainboardId))
      throw Error('Duplicate collector target')
    keys.add(p.printerKey)
    hosts.add(p.host)
    ids.add(p.mainboardId)
  }
  return config
}
export function readCollectorConfig(path: string) {
  return parseCollectorConfig(readPrivateJsonFile(path, { maxBytes: 65536 }))
}
