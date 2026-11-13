import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import {
  CONFIGURATION_DOMAINS,
  CONFIGURATION_PROTOCOL,
  configurationHash,
  configurationOpaqueId,
} from './configuration-common.ts'

const octet = '(?:0|[1-9][0-9]{0,2})'
const ipv4Pattern = new RegExp(`^${octet}(?:\\.${octet}){3}$`)

/**
 * Canonical dotted-quad IPv4 only (no leading zeros, no hostnames, no URLs).
 * Unspecified, multicast and reserved ranges are never endpoints. Whether a
 * private/loopback/link-local address is acceptable is Connector policy; the
 * wire only carries it as data.
 */
export const ConfigurationIpv4 = z.string().refine((value) => {
  if (!ipv4Pattern.test(value)) return false
  const parts = value.split('.').map(Number)
  if (parts.some((part) => part > 255)) return false
  const first = parts[0] ?? 0
  return first >= 1 && first <= 223
}, 'Expected canonical unicast IPv4')

export const ConfigurationEndpoint = z.strictObject({
  ipv4: ConfigurationIpv4,
  port: z.number().int().min(1).max(65535),
})
export type ConfigurationEndpoint = z.infer<typeof ConfigurationEndpoint>

/** Provisional until a qualification matrix says otherwise. Never proves physical support. */
export const ConfigurationModelSelection = z.strictObject({
  family: z.literal('anycubic-kobra-x'),
  provisional: z.literal(true),
})

export const ConfigurationBridgeSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connector-managed') }),
  z.strictObject({
    kind: z.literal('existing'),
    bridge_instance_id: configurationOpaqueId,
  }),
])
export type ConfigurationBridgeSelection = z.infer<
  typeof ConfigurationBridgeSelection
>

/**
 * Browser-supplied prepare intent. Contains no password, cookie, key, URL,
 * method or header. `device_id` is an optional expectation: first discovery
 * omits it because the identity is only known after the Connector observes
 * the printer. The observed identity is pinned by the signed prepared receipt
 * (`ConfigurationImmutableTarget` always requires it) and commit binds that
 * receipt's hash, so an omitted expectation never weakens commit.
 */
export const ConfigurationTarget = z.strictObject({
  v: z.literal(1),
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  backend: z.literal('kobralink-anycubic'),
  model: ConfigurationModelSelection,
  endpoint: ConfigurationEndpoint,
  device_id: configurationOpaqueId.optional(),
  bridge: ConfigurationBridgeSelection,
})
export type ConfigurationTarget = z.infer<typeof ConfigurationTarget>

const observedText = (max: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,${max - 1}}$`))
export const ConfigurationObservedFirmware = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({
    status: z.literal('observed'),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/),
  }),
])

/** Sanitized Connector observation. `unqualified` is the only claim this wire can make. */
export const ConfigurationObservedDevice = z.strictObject({
  device_id: configurationOpaqueId,
  model: observedText(64).nullable(),
  firmware: ConfigurationObservedFirmware,
  support: z.literal('unqualified'),
})
export type ConfigurationObservedDevice = z.infer<
  typeof ConfigurationObservedDevice
>

/** Fields that cannot change between prepare and commit. */
export const ConfigurationImmutableTarget = z.strictObject({
  target_sha256: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  device_id: configurationOpaqueId,
  bridge_instance_id: configurationOpaqueId,
})
export type ConfigurationImmutableTarget = z.infer<
  typeof ConfigurationImmutableTarget
>

export async function configurationTargetHash(input: unknown): Promise<string> {
  return configurationHash(
    CONFIGURATION_DOMAINS.targetHash,
    canonicalize(ConfigurationTarget.parse(input)),
  )
}
