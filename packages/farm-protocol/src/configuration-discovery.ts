import { z } from 'zod'
import { base64url } from './encoding.ts'
import { ConfigurationStatusRequest } from './configuration-frames.ts'
import { configurationCodec } from './configuration-common.ts'
import { BrowserDeviceUuid } from './browser-device-proof.ts'

export const DISCOVERY_TIMEOUT_MS = 5000
export const MAX_DISCOVERY_RESULTS = 64

// A status capability for an ordinary printer target cannot authorize a scan.
export async function discoveryTargetHash(): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          'Open3DFarmManager/configuration-discovery/v1\0',
        ),
      ),
    ),
  )
}

export async function discoveryRequest(requestId: string, operationId: string) {
  return ConfigurationStatusRequest.parse({
    v: 1,
    protocol: 'config-v1',
    type: 'status',
    request_id: requestId,
    operation_id: operationId,
    expected_revision: 0,
    target_sha256: await discoveryTargetHash(),
  })
}

const text = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/)
export const DiscoveryPrinter = z.object({
  vendor: z.enum(['bambu', 'moonraker']),
  host: z.ipv4(),
  port: z.number().int().min(1).max(65535).optional(),
  serial: text.optional(),
  model: text.optional(),
  name: text.optional(),
})
export const DiscoveryResult = z.discriminatedUnion('ok', [
  z.strictObject({
    request_id: BrowserDeviceUuid,
    ok: z.literal(true),
    printers: z.array(DiscoveryPrinter.strict()).max(MAX_DISCOVERY_RESULTS),
  }),
  z.strictObject({
    request_id: BrowserDeviceUuid,
    ok: z.literal(false),
    reason: z.enum(['busy', 'timeout', 'failed', 'rejected']),
  }),
])
export type DiscoveryResult = z.infer<typeof DiscoveryResult>
const codec = configurationCodec(DiscoveryResult, 'discovery result', {
  maxBytes: 60_000,
  maxDepth: 4,
  maxValues: 1024,
  maxStringChars: 128,
})
export const encodeDiscoveryResult = codec.encode
export const decodeDiscoveryResult = codec.decode
