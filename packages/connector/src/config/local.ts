import { parseBambuBinding } from '../bambu/configuration.ts'
import {
  KOBRALINK_CREDENTIAL_MAX_BYTES,
  KobraLinkRuntimeBinding,
  parseKobraLinkCredential,
} from '../kobralink/configuration.ts'
import { createKobraLinkClient } from '../kobralink/client.ts'
import { SpoolmanConfig } from '../spoolman/config.ts'
import { z } from 'zod'
import { validateMoonrakerInput } from './moonraker.ts'
import { MAX_CONFIG_BYTES, readPrivateJsonFile } from './private-json.ts'

export { readPrivateJsonFile }

// Timing is local configuration only; these bounds are not command safety policy.
const millis = z.number().int().min(100).max(300_000)
const Limits = z
  .strictObject({
    maxMessageBytes: z
      .number()
      .int()
      .min(256)
      .max(256 * 1024)
      .default(256 * 1024),
    connectTimeoutMs: millis.default(5000),
    requestTimeoutMs: millis.default(5000),
    staleAfterMs: millis.min(1000).default(30_000),
    reconnectMinMs: millis.default(1000),
    reconnectMaxMs: millis.default(30_000),
  })
  .default({
    maxMessageBytes: 256 * 1024,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    staleAfterMs: 30_000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30_000,
  })
const LegacyCollectorConfigSchema = z.strictObject({
  version: z.literal(1),
  allowedOrigins: z.array(z.string().min(1).max(2048)).min(1).max(16),
  printers: z
    .array(
      z.strictObject({
        printerKey: z.string().min(1).max(128),
        origin: z.string().min(1).max(2048),
        apiKeyFile: z.string().min(1).max(4096).optional(),
        /**
         * Locally declared model. "Snapmaker U1" opts the printer into the U1
         * tool mapping and the U1 command capability set.
         */
        model: z.string().min(1).max(128).optional(),
      }),
    )
    .min(1)
    .max(16),
  limits: Limits,
  spoolman: SpoolmanConfig.optional(),
})
const BambuSection = z.strictObject({
  printers: z
    .array(
      z.unknown().transform((value) => {
        const binding = parseBambuBinding(value)
        return {
          ...binding,
          allowedEndpoints: [{ host: binding.host, port: binding.port }],
        }
      }),
    )
    .min(1)
    .max(16),
})
export const LocalCollectorConfigSchema = z.union([
  LegacyCollectorConfigSchema.extend({
    version: z.literal(3),
    allowedOrigins: z.array(z.string().min(1).max(2048)).max(16),
    printers: z
      .array(LegacyCollectorConfigSchema.shape.printers.element)
      .max(16),
    bambu: BambuSection,
  }),
  LegacyCollectorConfigSchema,
  LegacyCollectorConfigSchema.extend({
    version: z.literal(2),
    allowedOrigins: z.array(z.string().min(1).max(2048)).max(16),
    printers: z
      .array(LegacyCollectorConfigSchema.shape.printers.element)
      .max(16),
    kobralink: z.strictObject({
      allowedOrigins: z.array(z.string().min(1).max(2048)).min(1).max(16),
      printers: z.array(KobraLinkRuntimeBinding).min(1).max(16),
    }),
  }),
])
export type LocalCollectorConfig = z.infer<typeof LocalCollectorConfigSchema>

export function parseLocalCollectorConfig(
  input: unknown,
): LocalCollectorConfig {
  const config = LocalCollectorConfigSchema.parse(input)
  const keys = new Set<string>()
  for (const assignment of config.printers) {
    // Validate every printer and every allowlist entry before any queue/network.
    validateMoonrakerInput({
      assignment,
      allowedOrigins: config.allowedOrigins,
      limits: config.limits,
    })
    if (keys.has(assignment.printerKey))
      throw new Error('Duplicate collector printer key')
    keys.add(assignment.printerKey)
  }
  if (config.version === 2) {
    if (config.printers.length + config.kobralink.printers.length > 16)
      throw Error('Collector capacity exceeded')
    const targets = new Set<string>()
    const devices = new Set<string>()
    const bridges = new Map<string, string>()
    for (const binding of config.kobralink.printers) {
      createKobraLinkClient({
        origin: binding.origin,
        allowedOrigins: config.kobralink.allowedOrigins,
      })
      parseKobraLinkCredential(
        binding,
        readPrivateJsonFile(binding.credentialFile, {
          maxBytes: KOBRALINK_CREDENTIAL_MAX_BYTES,
        }),
      )
      const target = JSON.stringify([binding.origin, binding.id])
      if (keys.has(binding.printerKey) || targets.has(target))
        throw Error('Duplicate collector target')
      const device = JSON.stringify([binding.bridgeInstance, binding.deviceId])
      if (
        devices.has(device) ||
        (bridges.has(binding.origin) &&
          bridges.get(binding.origin) !== binding.bridgeInstance)
      )
        throw Error('Ambiguous KobraLink identity')
      devices.add(device)
      bridges.set(binding.origin, binding.bridgeInstance)
      keys.add(binding.printerKey)
      targets.add(target)
    }
  }
  if (config.version === 3) {
    if (config.printers.length + config.bambu.printers.length > 16)
      throw Error('Collector capacity exceeded')
    const serials = new Set<string>()
    const endpoints = new Set<string>()
    for (const binding of config.bambu.printers) {
      const endpoint = JSON.stringify([binding.host, binding.port])
      if (
        keys.has(binding.printerKey) ||
        serials.has(binding.serial) ||
        endpoints.has(endpoint)
      )
        throw Error('Duplicate collector target')
      keys.add(binding.printerKey)
      serials.add(binding.serial)
      endpoints.add(endpoint)
    }
  }
  return config
}

export function readLocalCollectorConfig(path: string): LocalCollectorConfig {
  return parseLocalCollectorConfig(
    readPrivateJsonFile(path, { maxBytes: MAX_CONFIG_BYTES }),
  )
}
