import { z } from 'zod'
import { canonicalize } from './canonical.ts'
import { parseBoundedJson } from './json.ts'
import { base64url, decodeBase64url } from './encoding.ts'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import { CollectionArguments, ControlArguments } from './control-actions.ts'

/**
 * Command envelope for API-submitted jobs and actions: the server-to-Connector
 * command path of the third-party integration API. The envelope is signed by a
 * dedicated API issuer key that the Connector learns through the signed
 * trusted-key set (`trusted-keys.ts`) and is sent over the authenticated
 * credential inbox. It names the app, grant, farm, agent and printer assignment
 * so the Connector can pin its own identity, and it expires: the Connector
 * refuses an expired envelope and the server never resends after an uncertain
 * delivery. The Connector alone decides whether to execute.
 */
export const MAX_API_ENVELOPE_WIRE_BYTES = 4096
/** Shortest and longest time an undelivered envelope stays valid. */
export const MIN_API_ENVELOPE_TTL_MS = 1000
export const MAX_API_ENVELOPE_TTL_MS = 300_000
/** A Connector clock may run this far behind the issuer before `issued_at` looks future. */
export const API_ENVELOPE_CLOCK_SKEW_MS = 5000
export const MAX_API_ENVELOPE_FILE_URL_CHARS = 2048
export const MAX_API_ENVELOPE_NAME_CHARS = 255
export const MAX_API_ENVELOPE_DETAIL_CHARS = 500
/** The dedicated issuer id: it never doubles as the trusted-key-set or pairing issuer. */
export const API_ENVELOPE_ISSUER = 'open3dfarm:api-envelope-issuer'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const uuid = BrowserDeviceUuid
const kid = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
/** 128 random bits, base64url (22 characters). */
const nonce = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const httpsUrl = z
  .string()
  .max(MAX_API_ENVELOPE_FILE_URL_CHARS)
  .regex(/^https:\/\/[^\s\x00-\x1f\x7f]+$/)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    } catch {
      return false
    }
  })

/** Actions an API app may request; emergency stop, start_print and firmware restart are never API actions; start_library_print needs jobs:write. */
export const API_ENVELOPE_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'run_macro',
  'load_filament',
  'unload_filament',
  'start_library_print',
] as const
export const ApiRunAction = z.strictObject({
  action: z.enum(['job_pause', 'job_resume', 'job_cancel']),
  args: z.strictObject({ expectedRunId: uuid }),
})
export const ApiPlateAction = z.strictObject({
  action: z.literal('confirm_collection'),
  args: CollectionArguments,
})
export const ApiResinReplay = z.strictObject({
  action: z.literal('start_library_print'),
  args: z.strictObject({
    sha256,
    versionId: uuid,
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\/\\\x00-\x1f\x7f]+$/),
    profile: z.string().min(1).max(100),
    plate: z.literal(1),
  }),
})
export const ApiEnvelopeAction = z.union([
  ApiResinReplay,
  ApiRunAction,
  ApiPlateAction,
  ControlArguments.refine((value) =>
    (API_ENVELOPE_ACTIONS as readonly string[]).includes(value.action),
  ),
])
export type ApiEnvelopeAction = z.infer<typeof ApiEnvelopeAction>

export const API_RUN_CONTROLS = {
  job_pause: 'pause',
  job_resume: 'resume',
  job_cancel: 'cancel',
} as const

export const ApiEnvelopeScope = z.enum([
  'jobs:start',
  'jobs:write',
  'control:basic',
  'control:extended',
  'plates:confirm',
])

export function scopeForApiAction(action: ApiEnvelopeAction['action']) {
  switch (action) {
    case 'confirm_collection':
      return 'plates:confirm'
    case 'start_library_print':
      return 'jobs:write'
    case 'job_pause':
    case 'job_resume':
    case 'job_cancel':
    case 'pause':
    case 'resume':
    case 'cancel':
      return 'control:basic'
    default:
      return 'control:extended'
  }
}

export const ApiEnvelopeJob = z.strictObject({
  file_url: httpsUrl,
  sha256,
  size_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  display_name: z
    .string()
    .min(1)
    .max(MAX_API_ENVELOPE_NAME_CHARS)
    .regex(/^[^\x00-\x1f\x7f]+$/),
})
export type ApiEnvelopeJob = z.infer<typeof ApiEnvelopeJob>

const common = {
  v: z.literal(1),
  purpose: z.literal('api-envelope'),
  /** Signer; must be the dedicated API issuer. */
  issuer: z.literal(API_ENVELOPE_ISSUER),
  kid,
  app_id: uuid,
  grant_id: uuid,
  farm_id: uuid,
  agent_id: uuid,
  assignment_id: uuid,
  /** The API resource (job or action id) this command carries out. */
  resource_id: uuid,
  cmd_id: uuid,
  nonce,
  issued_at: time,
  expires_at: time,
  // Roll out Connector support before issuing these fields: older strict V1
  // parsers reject them. Connectors use the authenticated inbox scope for
  // legacy envelopes and require both signed claims when either is present.
  scope: ApiEnvelopeScope.optional(),
  /** Issuance-time authority epoch, revalidated by the delivery claim. */
  grant_epoch: time.optional(),
}
const expiryBounds = (value: { issued_at: number; expires_at: number }) =>
  value.expires_at - value.issued_at >= MIN_API_ENVELOPE_TTL_MS &&
  value.expires_at - value.issued_at <= MAX_API_ENVELOPE_TTL_MS
const claimsFields = {
  ...common,
  kind: z.enum(['job', 'action']),
  job: ApiEnvelopeJob.optional(),
  action: ApiEnvelopeAction.optional(),
}
/** Exactly one of `job` and `action`, matching `kind`. */
const kindMatches = (value: {
  kind: 'job' | 'action'
  job?: unknown
  action?: unknown
}) =>
  value.kind === 'job'
    ? value.job !== undefined && value.action === undefined
    : value.action !== undefined && value.job === undefined
export const ApiEnvelopeV1 = z
  .strictObject(claimsFields)
  .refine(expiryBounds)
  .refine(kindMatches)
export type ApiEnvelopeV1 = z.infer<typeof ApiEnvelopeV1>
export const SignedApiEnvelopeV1 = z
  .strictObject({ ...claimsFields, signature })
  .refine(expiryBounds)
  .refine(kindMatches)
export type SignedApiEnvelopeV1 = z.infer<typeof SignedApiEnvelopeV1>

/** The frame as sent over the inbox socket. */
export const ApiEnvelopeFrame = z.strictObject({
  v: z.literal(1),
  t: z.literal('api-envelope.command'),
  envelope: SignedApiEnvelopeV1,
})
export type ApiEnvelopeFrame = z.infer<typeof ApiEnvelopeFrame>

export const API_ENVELOPE_REFUSAL_CODES = [
  'printer-busy',
  'not-ready',
  'wrong-state',
  'checksum-mismatch',
  'grant-revoked',
  'expired',
  'unsupported',
] as const
export const ApiEnvelopeRefusalCode = z.enum(API_ENVELOPE_REFUSAL_CODES)
export type ApiEnvelopeRefusalCode = z.infer<typeof ApiEnvelopeRefusalCode>
export const API_ENVELOPE_OUTCOMES = [
  'delivered',
  'refused',
  'started',
  'completed',
  'cancelled',
  'failed',
] as const
/** What the Connector reports for an envelope it received. */
export const ApiEnvelopeResultFrame = z
  .strictObject({
    v: z.literal(1),
    t: z.literal('api-envelope.result'),
    cmd_id: uuid,
    outcome: z.enum(API_ENVELOPE_OUTCOMES),
    refusal_code: ApiEnvelopeRefusalCode.optional(),
    detail: z
      .string()
      .max(MAX_API_ENVELOPE_DETAIL_CHARS)
      .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/)
      .optional(),
    /** Job history entry once a print has ended (decimal, up to 19 digits). */
    history_entry_id: z
      .string()
      .regex(/^[0-9]{1,19}$/)
      .optional(),
    at: time,
  })
  .refine((value) => (value.outcome === 'refused') === !!value.refusal_code)
  .refine(
    (value) =>
      value.outcome === 'refused' ||
      value.outcome === 'failed' ||
      value.detail === undefined,
  )
  .refine(
    (value) =>
      value.history_entry_id === undefined ||
      ['completed', 'cancelled', 'failed'].includes(value.outcome),
  )
export type ApiEnvelopeResultFrame = z.infer<typeof ApiEnvelopeResultFrame>

function bounded(value: unknown): string {
  const wire = canonicalize(value)
  if (new TextEncoder().encode(wire).byteLength > MAX_API_ENVELOPE_WIRE_BYTES)
    throw new Error('API envelope byte limit exceeded')
  return wire
}
const jsonLimits = {
  maxBytes: MAX_API_ENVELOPE_WIRE_BYTES,
  maxDepth: 8,
  maxValues: 128,
  maxStringChars: MAX_API_ENVELOPE_FILE_URL_CHARS,
}
export function encodeApiEnvelopeFrame(input: unknown): string {
  return bounded(ApiEnvelopeFrame.parse(input))
}
export function decodeApiEnvelopeFrame(wire: unknown): ApiEnvelopeFrame {
  if (typeof wire !== 'string' || wire.length > MAX_API_ENVELOPE_WIRE_BYTES)
    throw new Error('Invalid API envelope frame')
  const parsed = ApiEnvelopeFrame.parse(parseBoundedJson(wire, jsonLimits))
  if (encodeApiEnvelopeFrame(parsed) !== wire)
    throw new Error('Canonical API envelope required')
  return parsed
}
export function encodeApiEnvelopeResultFrame(input: unknown): string {
  return bounded(ApiEnvelopeResultFrame.parse(input))
}
export function decodeApiEnvelopeResultFrame(
  wire: unknown,
): ApiEnvelopeResultFrame {
  if (typeof wire !== 'string' || wire.length > MAX_API_ENVELOPE_WIRE_BYTES)
    throw new Error('Invalid API envelope result frame')
  const parsed = ApiEnvelopeResultFrame.parse(
    parseBoundedJson(wire, jsonLimits),
  )
  if (encodeApiEnvelopeResultFrame(parsed) !== wire)
    throw new Error('Canonical API envelope result required')
  return parsed
}
export function apiEnvelopePayload(input: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    'Open3DFarmManager/api-envelope/v1\0' + bounded(ApiEnvelopeV1.parse(input)),
  )
}
/** A fresh random nonce for a new envelope. */
export function newApiEnvelopeNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)))
}

/** Trusted nonextractable Ed25519 issuer key only; deciding the content is the caller's job. */
export async function signApiEnvelope(
  input: unknown,
  key: CryptoKey,
): Promise<SignedApiEnvelopeV1> {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'Ed25519'
  )
    throw new Error('Trusted nonextractable Ed25519 issuer key required')
  const claims = ApiEnvelopeV1.parse(input)
  const sig = base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        key,
        apiEnvelopePayload(claims),
      ),
    ),
  )
  const signed = SignedApiEnvelopeV1.parse({ ...claims, signature: sig })
  encodeApiEnvelopeFrame({
    v: 1,
    t: 'api-envelope.command',
    envelope: signed,
  })
  return signed
}

export type ApiEnvelopeVerification = Readonly<{
  /** The Connector's own pinned farm and agent. */
  farmId: string
  agentId: string
  /** Wall clock of the verifier. */
  now: number
}>
export type ApiEnvelopeVerdict =
  | { ok: true; envelope: ApiEnvelopeV1 }
  | { ok: false; reason: 'invalid' | 'identity' | 'expired' | 'not-yet-valid' }
/**
 * Explicit pinned key only: no embedded key, algorithm choice or fallback.
 * Fails closed on a wrong farm or agent, an expired envelope and one issued
 * in the future beyond the clock skew allowance.
 */
export async function verifyApiEnvelope(
  input: unknown,
  key: CryptoKey,
  pin: ApiEnvelopeVerification,
): Promise<ApiEnvelopeVerdict> {
  try {
    if (key.type !== 'public' || key.algorithm.name !== 'Ed25519')
      return { ok: false, reason: 'invalid' }
    const parsed = SignedApiEnvelopeV1.parse(input)
    const { signature: sig, ...unsigned } = parsed
    const claims = ApiEnvelopeV1.parse(unsigned)
    const valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      new Uint8Array(decodeBase64url(sig, 64)),
      apiEnvelopePayload(claims),
    )
    if (!valid) return { ok: false, reason: 'invalid' }
    if (claims.farm_id !== pin.farmId || claims.agent_id !== pin.agentId)
      return { ok: false, reason: 'identity' }
    if (pin.now >= claims.expires_at) return { ok: false, reason: 'expired' }
    if (claims.issued_at > pin.now + API_ENVELOPE_CLOCK_SKEW_MS)
      return { ok: false, reason: 'not-yet-valid' }
    return { ok: true, envelope: claims }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
