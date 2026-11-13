import { z } from 'zod'
import { canonicalize } from '../../../../packages/farm-protocol/src/canonical.ts'
import { parseBoundedJson } from '../../../../packages/farm-protocol/src/json.ts'
import {
  BrowserDevicePublicKey,
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { CredentialProofChallenge } from '../../../../packages/farm-protocol/src/credential-proof.ts'
import { AuthenticatedSignallingFrame } from '../../../../packages/farm-protocol/src/authenticated-signalling.ts'
import { ConfigurationSessionBinding } from '../../../../packages/farm-protocol/src/configuration-binding.ts'
import {
  CONFIGURATION_HARD_MAXIMUMS,
  CONFIGURATION_PROTOCOL,
  configurationDigest,
  configurationLifetime,
  configurationSignature,
  configurationTime,
} from '../../../../packages/farm-protocol/src/configuration-common.ts'

/**
 * Socket control frames of the dedicated config-v1 signalling endpoints.
 * Only session descriptions and candidates are relayed. No configuration
 * action, target, receipt, credential or bridge data ever crosses this socket.
 */
export const MAX_CONFIGURATION_SIGNALLING_WIRE_BYTES = 12288
export const MAX_CONFIGURATION_INBOX_MS = 60_000

const base = { v: z.literal(1) }
const revision = z.number().int().nonnegative().max(2_147_483_646)
const lease = { issued_at: configurationTime, expires_at: configurationTime }
const context = {
  transport_id: BrowserDeviceUuid,
  farm_id: BrowserDeviceUuid,
  agent_id: BrowserDeviceUuid,
  key_id: BrowserDeviceUuid,
}

const ClientControl = z.discriminatedUnion('t', [
  z.strictObject({
    ...base,
    t: z.literal('config.begin'),
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    key_id: BrowserDeviceUuid,
  }),
  z.strictObject({
    ...base,
    t: z.literal('config.connector-begin'),
    farm_id: BrowserDeviceUuid,
    agent_id: BrowserDeviceUuid,
    jti: BrowserDeviceUuid,
    token: z.string().min(1).max(8192),
  }),
  z.strictObject({
    ...base,
    t: z.literal('config.connector-proof'),
    signature: configurationSignature,
  }),
  /** Sent only by a Connector whose local operator enabled configuration. */
  z.strictObject({
    ...base,
    t: z.literal('config.advertise'),
    protocol: z.literal(CONFIGURATION_PROTOCOL),
    enabled: z.literal(true),
    revision,
  }),
])
export const ConfigurationSignallingClientFrame = z.union([
  ClientControl,
  AuthenticatedSignallingFrame,
])
export type ConfigurationSignallingClientFrame = z.infer<
  typeof ConfigurationSignallingClientFrame
>

const ServerControl = z
  .discriminatedUnion('t', [
    z.strictObject({
      ...base,
      t: z.literal('config.connector-challenge'),
      challenge: CredentialProofChallenge,
    }),
    z.strictObject({
      ...base,
      t: z.literal('config.connector-ready'),
      inbox_id: BrowserDeviceUuid,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('config.retry'),
      retry_after_ms: z.number().int().min(1).max(60000),
    }),
    z.strictObject({
      ...base,
      t: z.literal('config.ready'),
      ...context,
      revision,
      browser_nonce: configurationDigest,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('config.context-request'),
      ...context,
      account_id: BrowserDeviceTextId,
      browser_public_key: BrowserDevicePublicKey,
      browser_thumbprint: configurationDigest,
      connector_nonce: configurationDigest,
      ...lease,
    }),
    z.strictObject({
      ...base,
      t: z.literal('config.binding'),
      binding: ConfigurationSessionBinding,
    }),
    z.strictObject({
      ...base,
      t: z.literal('config.context-closed'),
      transport_id: BrowserDeviceUuid,
    }),
  ])
  .refine(
    (frame) =>
      !('issued_at' in frame) ||
      configurationLifetime(
        frame,
        frame.t === 'config.connector-ready'
          ? MAX_CONFIGURATION_INBOX_MS
          : CONFIGURATION_HARD_MAXIMUMS.bindingMs,
      ),
  )
export const ConfigurationSignallingServerFrame = z.union([
  ServerControl,
  AuthenticatedSignallingFrame,
])
export type ConfigurationSignallingServerFrame = z.infer<
  typeof ConfigurationSignallingServerFrame
>

function bounded(value: unknown): string {
  const wire = canonicalize(value)
  if (Buffer.byteLength(wire) > MAX_CONFIGURATION_SIGNALLING_WIRE_BYTES)
    throw new Error('Configuration signalling byte limit exceeded')
  return wire
}
function parse(wire: unknown): unknown {
  if (
    typeof wire !== 'string' ||
    wire.length > MAX_CONFIGURATION_SIGNALLING_WIRE_BYTES
  )
    throw new Error('Invalid configuration signalling frame')
  return parseBoundedJson(wire, {
    maxBytes: MAX_CONFIGURATION_SIGNALLING_WIRE_BYTES,
    maxDepth: 7,
    maxValues: 128,
    maxStringChars: 8192,
  })
}
export function encodeConfigurationSignallingClientFrame(
  input: unknown,
): string {
  return bounded(ConfigurationSignallingClientFrame.parse(input))
}
export function encodeConfigurationSignallingServerFrame(
  input: unknown,
): string {
  return bounded(ConfigurationSignallingServerFrame.parse(input))
}
/** Canonical-only: a re-encoded frame must equal the received text. */
export function decodeConfigurationSignallingClientFrame(
  wire: unknown,
): ConfigurationSignallingClientFrame {
  const frame = ConfigurationSignallingClientFrame.parse(parse(wire))
  if (encodeConfigurationSignallingClientFrame(frame) !== wire)
    throw new Error('Canonical configuration signalling required')
  return frame
}
export function decodeConfigurationSignallingServerFrame(
  wire: unknown,
): ConfigurationSignallingServerFrame {
  const frame = ConfigurationSignallingServerFrame.parse(parse(wire))
  if (encodeConfigurationSignallingServerFrame(frame) !== wire)
    throw new Error('Canonical configuration signalling required')
  return frame
}
