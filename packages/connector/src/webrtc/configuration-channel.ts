import { z } from 'zod'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  MAX_CONFIGURATION_FRAME_WIRE_BYTES,
  MAX_CONFIGURATION_PROOF_WIRE_BYTES,
  configurationDigest,
} from '../../../farm-protocol/src/configuration-common.ts'

/**
 * config-v1 data channel envelope between the browser and the Connector.
 * Label `configuration-v1`, ordered, reliable. Inner `proof`, `frame`,
 * `capability`, `admission` and `receipt` fields carry the exact canonical
 * wire of the accepted farm-protocol codecs; the envelope adds no URL, method,
 * header, credential or free-form payload.
 *
 * browser -> Connector
 *   { v:1, t:'proof', proof }                         browser session proof
 *   { v:1, t:'request', frame, capability, admission } one config-v1 action
 *   { v:1, t:'inventory', operation_id, local_committed_receipt_sha256,
 *     committed_revision, attestation }               server inventory confirmation
 * Connector -> browser
 *   { v:1, t:'proof', proof }                         Connector session proof
 *   { v:1, t:'response', frame }                      config-v1 response frame
 *   { v:1, t:'inventory-result', operation_id, ok, reason, receipt }
 */
export const CONFIGURATION_CHANNEL_LABEL = 'configuration-v1'
export const MAX_CONFIGURATION_CHANNEL_BYTES = 40_000
const revision = z.number().int().min(1).max(2_147_483_646)
const proofWire = z.string().min(1).max(MAX_CONFIGURATION_PROOF_WIRE_BYTES)
const frameWire = z.string().min(1).max(MAX_CONFIGURATION_FRAME_WIRE_BYTES)

export const BrowserChannelMessage = z.discriminatedUnion('t', [
  z.strictObject({ v: z.literal(1), t: z.literal('proof'), proof: proofWire }),
  z.strictObject({
    v: z.literal(1),
    t: z.literal('request'),
    frame: frameWire,
    capability: proofWire,
    admission: proofWire,
  }),
  z.strictObject({
    v: z.literal(1),
    t: z.literal('inventory'),
    operation_id: BrowserDeviceUuid,
    local_committed_receipt_sha256: configurationDigest,
    committed_revision: revision,
    attestation: proofWire,
  }),
])
export type BrowserChannelMessage = z.infer<typeof BrowserChannelMessage>

export const InventoryResultReason = z.enum([
  'unknown',
  'mismatch',
  'rejected',
  'busy',
  'not-available',
])
export const ConnectorChannelMessage = z.discriminatedUnion('t', [
  z.strictObject({ v: z.literal(1), t: z.literal('proof'), proof: proofWire }),
  z.strictObject({
    v: z.literal(1),
    t: z.literal('response'),
    frame: frameWire,
  }),
  z.strictObject({
    v: z.literal(1),
    t: z.literal('inventory-result'),
    operation_id: BrowserDeviceUuid,
    ok: z.boolean(),
    reason: InventoryResultReason.nullable(),
    receipt: proofWire.nullable(),
  }),
])
export type ConnectorChannelMessage = z.infer<typeof ConnectorChannelMessage>

const limits = {
  maxBytes: MAX_CONFIGURATION_CHANNEL_BYTES,
  maxDepth: 2,
  maxValues: 16,
  maxStringChars: MAX_CONFIGURATION_FRAME_WIRE_BYTES,
}

function codec<T>(schema: z.ZodType<T>) {
  const encode = (input: unknown): string => {
    const wire = canonicalize(schema.parse(input))
    if (new TextEncoder().encode(wire).byteLength > limits.maxBytes)
      throw new Error('Configuration channel byte limit')
    return wire
  }
  return {
    encode,
    decode(wire: unknown): T {
      if (typeof wire !== 'string' || wire.length > limits.maxBytes)
        throw new Error('Invalid configuration channel message')
      const parsed = schema.parse(parseBoundedJson(wire, limits))
      if (encode(parsed) !== wire)
        throw new Error('Canonical configuration channel message required')
      return parsed
    },
  }
}
const browser = codec(BrowserChannelMessage)
const connector = codec(ConnectorChannelMessage)
export const encodeBrowserChannelMessage = browser.encode
export const decodeBrowserChannelMessage = browser.decode
export const encodeConnectorChannelMessage = connector.encode
export const decodeConnectorChannelMessage = connector.decode
