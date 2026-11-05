import { z } from 'zod'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import { canonicalize } from './canonical.ts'
import { base64url } from './encoding.ts'

const uuid = z
  .string()
  .length(36)
  .transform((value) => value.toLowerCase())
  .pipe(BrowserDeviceUuid)
// Same PostgreSQL UTF8 key contract as Connector configuration: preserve code
// points exactly, rejecting NUL and isolated UTF16 surrogates.
export const RtcAssignmentRef = z.strictObject({
  assignmentId: uuid,
  agentId: uuid,
  printerKey: z
    .string()
    .min(1)
    .max(128)
    .refine((key) => !/[\u0000\uD800-\uDFFF]/u.test(key)),
})
export type RtcAssignmentRef = z.infer<typeof RtcAssignmentRef>
export const MAX_RTC_ASSIGNMENTS = 16
// A key needs at most 128*6 escaped bytes. Sixteen tuples plus fixed scope
// fit below 16KiB even when every key consists of escaped control characters.
export const MAX_RTC_ASSIGNMENT_SET_BYTES = 16384

export async function assignmentSetDigest(
  scope: Readonly<{ farmId: string; agentId: string }>,
  refs: readonly RtcAssignmentRef[],
): Promise<Readonly<{ count: number; digest: string }>> {
  const farmId = uuid.parse(scope.farmId)
  const agentId = uuid.parse(scope.agentId)
  const parsed = z
    .array(RtcAssignmentRef)
    .min(1)
    .max(MAX_RTC_ASSIGNMENTS)
    .parse(refs)
  const ids = new Set<string>(),
    keys = new Set<string>()
  for (const ref of parsed) {
    if (
      ref.agentId !== agentId ||
      ids.has(ref.assignmentId) ||
      keys.has(ref.printerKey)
    )
      throw Error('Invalid RTC assignment scope or duplicate')
    ids.add(ref.assignmentId)
    keys.add(ref.printerKey)
  }
  parsed.sort((a, b) =>
    a.assignmentId < b.assignmentId
      ? -1
      : a.assignmentId > b.assignmentId
        ? 1
        : 0,
  )
  const bytes = new TextEncoder().encode(
    canonicalize({
      v: 1,
      domain: 'open3dfarmmanager:rtc-assignment-set:v1',
      farm_id: farmId,
      agent_id: agentId,
      assignments: parsed.map((ref) => ({
        assignment_id: ref.assignmentId,
        printer_key: ref.printerKey,
      })),
    }),
  )
  if (bytes.byteLength > MAX_RTC_ASSIGNMENT_SET_BYTES)
    throw Error('RTC assignment byte limit')
  return Object.freeze({
    count: parsed.length,
    digest: base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ),
  })
}
