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

import { Binding as QidiBinding, readQidiAuth } from '../qidi/config.ts'
import { Binding as PhrozenBinding } from '../phrozen/config.ts'
import { Binding as PhotonResinBinding } from '../anycubic-resin/config.ts'
import { Binding as HalotBinding, readHalotPassword } from '../halot/config.ts'
import {
  FlashforgeBindingSchema,
  readFlashforgeCredentials,
} from '../flashforge/config.ts'
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
const NativeOnlyCollection = LocalCollectorConfigSchema.options[1].extend({
  allowedOrigins: z.tuple([]),
  printers: z.tuple([]),
})
const DriverBinding = z.discriminatedUnion('family', [
  Driver,
  QidiBinding,
  PhrozenBinding,
  FlashforgeBindingSchema,
  PhotonResinBinding,
  HalotBinding,
])
const CollectorOrigin = z.union([
  LocalOrigin,
  PhrozenBinding.shape.origin,
  HalotBinding.shape.origin,
])
const Config = LocalCollectorConfigSchema.options[0]
  .omit({ bambu: true })
  .extend({
    version: z.literal(8),
    allowedOrigins: z.array(CollectorOrigin).min(1).max(16),
    drivers: z.array(DriverBinding).min(1).max(16),
  })
export type PrusaCollectorConfig = z.infer<typeof Config>

export function parseCollectorConfig(input: unknown, nativeKobraX = false) {
  if (nativeKobraX) {
    const nativeOnly = NativeOnlyCollection.safeParse(input)
    if (nativeOnly.success) return nativeOnly.data
  }
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
    CollectorOrigin.parse(origin)
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
    throw Error('Invalid driver collector capacity or duplicate target')
  if (base.printers.length)
    parseLocalCollectorConfig({
      ...base,
      version: 1,
      allowedOrigins: base.allowedOrigins.filter(
        (origin) => LocalOrigin.safeParse(origin).success,
      ),
    })
  if (
    base.spoolman?.credentialFile &&
    !readSpoolmanAuthorization(
      base.spoolman.credentialFile,
      base.spoolman.origin,
    )
  )
    throw Error('Invalid private Spoolman credential')
  for (const printer of base.printers) LocalOrigin.parse(printer.origin)
  if (base.spoolman) LocalOrigin.parse(base.spoolman.origin)
  for (const driver of drivers) {
    if (driver.family === 'prusa-link') readPrusaLinkApiKey(driver)
    if (driver.family === 'qidi') readQidiAuth(driver)
    if (driver.family === 'halot') readHalotPassword(driver)
    if (driver.family === 'flashforge') readFlashforgeCredentials(driver)
  }
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
