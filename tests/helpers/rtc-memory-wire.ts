// SPDX-License-Identifier: MIT
import { createRequire } from 'node:module'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { RtcSessionBinding } from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import { ControlSessionBinding } from '../../packages/farm-protocol/src/control-session-binding.ts'
import { RtcAssignmentRef } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import { BrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

export const native: typeof import('../../packages/connector/node_modules/node-datachannel') =
  createRequire(
    new URL('../../packages/connector/package.json', import.meta.url),
  )('node-datachannel')
export const Role = z.enum(['status', 'camera', 'control'])
export type Role = z.infer<typeof Role>
export const Command = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('start'),
    role: z.enum(['status', 'camera']),
  }),
  z.strictObject({ kind: z.literal('hello') }),
  z.strictObject({
    kind: z.literal('offer'),
    role: Role,
    sdp: z.string().max(16384),
  }),
  z.strictObject({
    kind: z.literal('bind'),
    role: z.enum(['status', 'camera']),
    binding: RtcSessionBinding,
    refs: z.array(RtcAssignmentRef).min(1).max(16),
  }),
  z.strictObject({
    kind: z.literal('control'),
    binding: ControlSessionBinding,
  }),
  z.strictObject({ kind: z.literal('observe') }),
  z.strictObject({ kind: z.literal('reset') }),
  z.strictObject({ kind: z.literal('stop') }),
])
export type Command = z.infer<typeof Command>
export const Observation = z.strictObject({
  ready: z.number().int().min(0).max(3),
  statuses: z.number().int().nonnegative(),
  cameraPackets: z.number().int().nonnegative(),
  cameraBytes: z.number().int().nonnegative(),
})
export const Reply = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hello'),
    publicKey: BrowserDevicePublicKey,
    thumbprint: z.string(),
    pid: z.number().int(),
  }),
  z.strictObject({ kind: z.literal('answer'), sdp: z.string().max(16384) }),
  z.strictObject({ kind: z.literal('ok') }),
  z.strictObject({ kind: z.literal('observation'), ...Observation.shape }),
  z.strictObject({ kind: z.literal('error'), message: z.string().max(500) }),
])
export async function until(
  check: () => boolean,
  label: string,
  timeoutMs = 8000,
) {
  const end = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= end) throw Error(label + ' deadline')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}
