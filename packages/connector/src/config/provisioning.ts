import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { createPrinterNetworkPolicy } from '../provisioning/policy.ts'
import { readPrivateJsonFile } from './local.ts'

/**
 * Explicit configuration-provisioning mode for a paired Connector that may
 * have zero printers. It is a separate local file: the strict runtime reader
 * (nonempty collection and assignments) is unchanged and is still the only
 * reader of the committed runtime file.
 *
 * Every trust anchor here is local operator configuration. The browser never
 * supplies a management origin, farm origin or issuer key.
 */
const AbsolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes('\0'))

/** Only an owned loopback HTTP management service (no LAN, no proxy, no path). */
export const ManagedBridgeOrigin = z
  .string()
  .max(64)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.origin === value &&
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
        url.port !== ''
      )
    } catch {
      return false
    }
  }, 'Managed bridge must be an owned loopback origin')

/** The enrolled farm origin: HTTPS only, origin form only. */
export const FarmOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.origin === value && url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Farm origin must be an exact HTTPS origin')

const RuntimeTemplate = z.strictObject({
  telemetry: z.unknown(),
  renewal: z.unknown().optional(),
  signalling: z.unknown().optional(),
  rtc: z.unknown().optional(),
})

export const ProvisioningConfig = z.strictObject({
  version: z.literal(1),
  mode: z.literal('configuration-provisioning'),
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  farmOrigin: FarmOrigin,
  /** Credential audience for signalling proofs (enrollment audience). */
  credentialAudience: z.string().min(1).max(256),
  stateDirectory: AbsolutePath,
  runtimeConfigPath: AbsolutePath,
  printerNetworks: z.array(z.string().max(32)).min(1).max(16),
  managedBridge: z
    .strictObject({
      origin: ManagedBridgeOrigin,
      ownership: z.literal('connector-owned-fresh'),
    })
    .nullable(),
  /** Seeds the first runtime only while the runtime file does not exist. */
  runtimeTemplate: RuntimeTemplate,
  rtc: z.strictObject({ bindAddress: z.string().min(1).max(64) }).optional(),
})
export type ProvisioningConfig = z.infer<typeof ProvisioningConfig>

export function parseProvisioningConfig(input: unknown): ProvisioningConfig {
  const config = ProvisioningConfig.parse(input)
  // Fails closed on a public or malformed printer network.
  createPrinterNetworkPolicy(config.printerNetworks)
  if (config.stateDirectory === config.runtimeConfigPath)
    throw new Error('Provisioning paths must differ')
  return Object.freeze(config)
}

export function readProvisioningConfig(path: string): ProvisioningConfig {
  return parseProvisioningConfig(
    readPrivateJsonFile(path, { maxBytes: 16 * 1024, maxStringChars: 4096 }),
  )
}

/** The non-collection runtime sections a zero-printer commit may seed. */
export function runtimeBootstrap(
  config: ProvisioningConfig,
): Readonly<Record<string, unknown>> {
  const template = config.runtimeTemplate
  return Object.freeze(
    Object.fromEntries(
      Object.entries(template).filter(([, value]) => value !== undefined),
    ),
  )
}
