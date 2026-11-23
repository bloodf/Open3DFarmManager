import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  LocalCollectorConfigSchema,
  parseLocalCollectorConfig,
  readPrivateJsonFile,
} from '../config/local.ts'
import { isLocalFormlabsHost } from '../formlabs/index.ts'
import { parseCollectorConfig as parseLegacy } from '../formlabs/config.ts'
import { readSpoolmanAuthorization } from '../spoolman/credential.ts'

const Key = z.string().trim().min(1).max(128)
const LocalOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      const host = url.hostname.replace(/^\[|\]$/g, '')
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        value === url.origin &&
        url.port !== '0' &&
        isLocalFormlabsHost(host)
      )
    } catch {
      return false
    }
  }, 'Canonical local HTTP origin required')

const Driver = z.strictObject({
  family: z.literal('prusa-link'),
  printerKey: Key,
  origin: LocalOrigin,
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
    allowedOrigins: z.array(LocalOrigin).min(1).max(16),
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
  const allowed = new Set(base.allowedOrigins)
  if (allowed.size !== base.allowedOrigins.length)
    throw Error('Duplicate collector allowed origin')
  const printers = [...base.printers, ...drivers]
  const keys = new Set(printers.map((printer) => printer.printerKey))
  const targets = [
    ...printers.map((printer) => printer.origin),
    ...(base.spoolman ? [base.spoolman.origin] : []),
  ]
  const endpoints = new Set<string>()
  for (const origin of targets) {
    LocalOrigin.parse(origin)
    if (!allowed.has(origin)) throw Error('Collector origin is not allowlisted')
    const url = new URL(origin)
    endpoints.add(
      `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`,
    )
  }
  if (
    printers.length > 16 ||
    keys.size !== printers.length ||
    endpoints.size !== targets.length
  )
    throw Error('Invalid PrusaLink collector capacity or duplicate target')
  if (base.printers.length) parseLocalCollectorConfig({ ...base, version: 1 })
  if (
    base.spoolman?.credentialFile &&
    !readSpoolmanAuthorization(
      base.spoolman.credentialFile,
      base.spoolman.origin,
    )
  )
    throw Error('Invalid private Spoolman credential')
  for (const driver of drivers) readPrusaLinkApiKey(driver)
  return config
}

const Credential = z.strictObject({
  origin: z.string(),
  apiKey: z.string().regex(/^[!-~]{1,256}$/),
})

export function readPrusaLinkApiKey(binding: PrusaLinkBinding): string {
  try {
    const credential = Credential.parse(
      readPrivateJsonFile(binding.apiKeyFile, { maxBytes: 8192 }),
    )
    if (credential.origin !== binding.origin) throw Error()
    return credential.apiKey
  } catch {
    throw Error('Invalid private PrusaLink credential')
  }
}
