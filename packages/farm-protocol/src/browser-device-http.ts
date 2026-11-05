import { z } from 'zod'
import {
  BrowserDeviceUuid,
  BrowserDeviceTextId,
  BrowserDevicePublicKey,
  BrowserDeviceProofChallenge,
  BrowserDeviceRole,
  BrowserDeviceDecisionRequest,
} from './browser-device-proof.ts'

export const BROWSER_DEVICE_HTTP_AUDIENCE = 'open3dfarmmanager:browser-device'
export const BROWSER_DEVICE_HTTP_LIMITS = Object.freeze({
  pendingLifetimeMs: 86_400_000,
  proofLifetimeMs: 60_000,
  maxChallengesPerKey: 3,
})
export const BrowserDeviceHttpLimits = z.strictObject({
  pendingLifetimeMs: z.literal(86_400_000),
  proofLifetimeMs: z.literal(60_000),
  maxChallengesPerKey: z.literal(3),
})
export const BrowserDeviceHttpChallengeRequest = z.strictObject({
  farm_id: BrowserDeviceUuid,
  public_key: BrowserDevicePublicKey,
})
export const BrowserDeviceHttpProofRequest = z.strictObject({
  challenge_id: BrowserDeviceUuid,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/),
})
export const BrowserDeviceHttpDecisionRequest = BrowserDeviceDecisionRequest
export const BrowserDeviceHttpListRequest = z.strictObject({
  farm_id: BrowserDeviceUuid,
  limit: z.number().int().min(1).max(50).default(20),
  after: BrowserDeviceUuid.optional(),
})
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const BrowserDeviceHttpDevice = z.strictObject({
  keyId: BrowserDeviceUuid,
  accountId: BrowserDeviceTextId,
  thumbprint: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  status: z.enum(['pending', 'approved', 'revoked']),
  proofAt: time.nullable(),
})
export const BrowserDeviceHttpListedDevice = BrowserDeviceHttpDevice.extend({
  createdAt: time,
  pendingExpiresAt: time.nullable(),
})
export const BrowserDeviceHttpListResponse = z.strictObject({
  currentAccountId: BrowserDeviceTextId,
  currentRole: BrowserDeviceRole,
  devices: z.array(BrowserDeviceHttpListedDevice).max(50),
  nextAfter: BrowserDeviceUuid.nullable(),
  limits: BrowserDeviceHttpLimits,
})
export type BrowserDeviceHttpListResponse = z.infer<
  typeof BrowserDeviceHttpListResponse
>
export const BrowserDeviceHttpChallengeResponse = z.strictObject({
  challenge: BrowserDeviceProofChallenge,
  limits: BrowserDeviceHttpLimits,
})
export const BrowserDeviceHttpMutationResponse = z.strictObject({
  device: BrowserDeviceHttpDevice,
  limits: BrowserDeviceHttpLimits,
})
export const BrowserDeviceHttpRuntimeConfig = z.strictObject({
  enabled: z.literal(true),
  databaseUrl: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
      } catch {
        return false
      }
    }),
})

export const BrowserDeviceHttpAccountResponse = z.strictObject({
  accountId: BrowserDeviceTextId,
})
export const BrowserDeviceHttpFarmPageResponse = z.object({
  farms: z.array(z.object({ farmId: BrowserDeviceUuid })).max(50),
  nextAfter: BrowserDeviceUuid.nullable(),
})
