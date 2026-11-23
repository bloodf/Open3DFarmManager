import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
} from '../config/local.ts'
import { parseCollectorConfig as parseLegacy } from '../formlabs/config.ts'

const Key = z.string().trim().min(1).max(128)
const Driver = z.strictObject({
  family: z.literal('prusa-link'),
  printerKey: Key,
  origin: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .refine((origin) => new URL(origin).origin === origin),
  apiKeyFile: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path) && !path.includes('\0')),
  expect: z.strictObject({ serial: Key, printerType: Key }),
})
export type PrusaLinkBinding = z.infer<typeof Driver>
const Config = LocalCollectorConfigSchema.options[0]
  .omit({ bambu: true })
  .extend({
    version: z.literal(8),
    drivers: z.array(Driver).min(1).max(16),
  })
export type PrusaCollectorConfig = z.infer<typeof Config>

export function parseCollectorConfig(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    input.version !== 8
  )
    return parseLegacy(input)
  const config = Config.parse(input)
  const { drivers, ...base } = config
  if (base.printers.length) parseLocalCollectorConfig({ ...base, version: 1 })
  const keys = [...base.printers, ...drivers].map((p) => p.printerKey)
  if (
    keys.length > 16 ||
    new Set(keys).size !== keys.length ||
    new Set(drivers.map((p) => p.origin)).size !== drivers.length
  )
    throw Error('Invalid PrusaLink collector capacity or duplicate target')
  return config
}
