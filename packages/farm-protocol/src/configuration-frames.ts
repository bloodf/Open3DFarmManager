import { z } from 'zod'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import {
  CONFIGURATION_PROTOCOL,
  MAX_CONFIGURATION_FRAME_WIRE_BYTES,
  configurationCodec,
  configurationDigest,
} from './configuration-common.ts'
import { SignedConfigurationReceipt } from './configuration-receipt.ts'
import {
  ConfigurationTarget,
  configurationTargetHash,
} from './configuration-target.ts'

/**
 * Closed config-v1 frames. There is deliberately no URL, method, header,
 * password, cookie, key or free-form payload field anywhere: strict objects
 * reject them, so they cannot be proxied through this channel.
 */
const revision = z.number().int().nonnegative().max(2_147_483_646)
const common = {
  v: z.literal(1),
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  request_id: BrowserDeviceUuid,
  operation_id: BrowserDeviceUuid,
  expected_revision: revision,
}
export const ConfigurationPrepareRequest = z.strictObject({
  ...common,
  type: z.literal('prepare'),
  target: ConfigurationTarget,
})
export const ConfigurationCommitRequest = z.strictObject({
  ...common,
  type: z.literal('commit'),
  target_sha256: configurationDigest,
  prepared_receipt_sha256: configurationDigest,
})
export const ConfigurationStatusRequest = z.strictObject({
  ...common,
  type: z.literal('status'),
  target_sha256: configurationDigest,
})
export const ConfigurationCancelRequest = z.strictObject({
  ...common,
  type: z.literal('cancel'),
  target_sha256: configurationDigest,
})
export const ConfigurationRequestFrame = z.discriminatedUnion('type', [
  ConfigurationPrepareRequest,
  ConfigurationCommitRequest,
  ConfigurationStatusRequest,
  ConfigurationCancelRequest,
])
export type ConfigurationRequestFrame = z.infer<
  typeof ConfigurationRequestFrame
>

export const ConfigurationUnknownReason = z.enum([
  'no-durable-record',
  'connector-restarted',
  'timeout-after-write',
  'cancel-acknowledged',
])
export const ConfigurationErrorCode = z.enum([
  'invalid-request',
  'unsupported-version',
  'not-available',
  'capability-rejected',
  'revision-conflict',
  'identity-conflict',
  'firmware-unsupported',
  'bridge-unavailable',
  'busy',
  'expired',
])
export type ConfigurationErrorCode = z.infer<typeof ConfigurationErrorCode>

const resultStates = z.enum([
  'prepared',
  'local-committed',
  'inventory-confirmed',
  'recovery-required',
])
export const ConfigurationReceiptResult = z.strictObject({
  v: z.literal(1),
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  type: z.literal('result'),
  request_id: BrowserDeviceUuid,
  operation_id: BrowserDeviceUuid,
  state: resultStates,
  receipt: SignedConfigurationReceipt,
})
export const ConfigurationUnknownResult = z.strictObject({
  v: z.literal(1),
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  type: z.literal('unknown'),
  request_id: BrowserDeviceUuid,
  operation_id: BrowserDeviceUuid,
  state: z.literal('unknown'),
  reason: ConfigurationUnknownReason,
})
export const ConfigurationErrorResponse = z.strictObject({
  v: z.literal(1),
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  type: z.literal('error'),
  request_id: BrowserDeviceUuid.nullable(),
  code: ConfigurationErrorCode,
})
export const ConfigurationResponseFrame = z
  .discriminatedUnion('type', [
    ConfigurationReceiptResult,
    ConfigurationUnknownResult,
    ConfigurationErrorResponse,
  ])
  .refine(
    (value) =>
      value.type !== 'result' ||
      (value.receipt.phase === value.state &&
        value.receipt.operation_id === value.operation_id),
    'Result state must equal its receipt phase',
  )
export type ConfigurationResponseFrame = z.infer<
  typeof ConfigurationResponseFrame
>

const limits = {
  maxBytes: MAX_CONFIGURATION_FRAME_WIRE_BYTES,
  maxDepth: 8,
  maxValues: 160,
  maxStringChars: 512,
}
const requestCodec = configurationCodec(
  ConfigurationRequestFrame,
  'configuration request',
  limits,
)
const responseCodec = configurationCodec(
  ConfigurationResponseFrame,
  'configuration response',
  limits,
)
export const encodeConfigurationRequest = requestCodec.encode
export const decodeConfigurationRequest = requestCodec.decode
export const encodeConfigurationResponse = responseCodec.encode
export const decodeConfigurationResponse = responseCodec.decode

/**
 * The hash an authority claim must carry. prepare: hash of the exact target.
 * commit: hash of the prepared receipt, which pins identity and the resolved
 * bridge. status/cancel: hash of the original prepare target.
 */
export async function configurationFrameTargetHash(
  input: unknown,
): Promise<string> {
  const frame = ConfigurationRequestFrame.parse(input)
  return frame.type === 'prepare'
    ? configurationTargetHash(frame.target)
    : frame.type === 'commit'
      ? frame.prepared_receipt_sha256
      : frame.target_sha256
}
