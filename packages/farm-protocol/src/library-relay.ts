import { z } from 'zod'

/**
 * Connector-mode library relay (#376, #377, #446). The server never dials a
 * Connector: the Connector asks over its authenticated HTTPS channel (the same
 * credential headers telemetry and library downloads use) and the server hands
 * it one operation at a time. Operations carry hashes and byte ranges only;
 * the file bytes of an upload travel in the body of a separate stream request
 * and the bytes of a read travel in the result body.
 */
export const LIBRARY_RELAY_POLL_PATH = '/api/connector/library/relay/poll'
export const libraryRelayBodyPath = (opId: string) =>
  `/api/connector/library/relay/${opId}/body`
export const libraryRelayResultPath = (opId: string) =>
  `/api/connector/library/relay/${opId}/result`

/** One read operation returns at most this many bytes. */
export const LIBRARY_RELAY_MAX_READ = 4 * 1024 * 1024
export const LIBRARY_RELAY_MAX_PURGE = 500
export const LIBRARY_RELAY_MAX_SWEEP = 10_000
/** Longest a poll is held open by the server. */
export const LIBRARY_RELAY_POLL_MS = 25_000

export const LIBRARY_RELAY_OP_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const opId = z.string().regex(LIBRARY_RELAY_OP_ID)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const LibraryRelayOp = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('put'),
    op_id: opId,
    max_bytes: count,
  }),
  z.strictObject({
    type: z.literal('read'),
    op_id: opId,
    sha256,
    offset: count,
    length: z.number().int().positive().max(LIBRARY_RELAY_MAX_READ),
  }),
  z.strictObject({ type: z.literal('discard'), op_id: opId, sha256 }),
  z.strictObject({
    type: z.literal('purge'),
    op_id: opId,
    sha256s: z.array(sha256).min(1).max(LIBRARY_RELAY_MAX_PURGE),
  }),
  z.strictObject({
    type: z.literal('sweep'),
    op_id: opId,
    referenced: z.array(sha256).max(LIBRARY_RELAY_MAX_SWEEP),
  }),
])
export type LibraryRelayOpValue = z.infer<typeof LibraryRelayOp>

export const LibraryRelayPoll = z.strictObject({ op: LibraryRelayOp })

export const LibraryRelayFailureReason = z.enum([
  'too-large',
  'quota-exceeded',
  'disk-full',
  'not-found',
  'hash-mismatch',
  'failed',
])
export type LibraryRelayFailureReasonValue = z.infer<
  typeof LibraryRelayFailureReason
>

/** JSON results; a successful `read` answers with the raw bytes instead. */
export const LibraryRelayResult = z.union([
  z.strictObject({
    ok: z.literal(true),
    type: z.literal('put'),
    sha256,
    size: count,
    created: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(true), type: z.literal('discard') }),
  z.strictObject({
    ok: z.literal(true),
    type: z.enum(['purge', 'sweep']),
    removed: z.array(sha256).max(LIBRARY_RELAY_MAX_SWEEP),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: LibraryRelayFailureReason,
  }),
])
export type LibraryRelayResultValue = z.infer<typeof LibraryRelayResult>
