import { z } from 'zod'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import { PrinterFile } from './file-list.ts'

export const API_QUERY_SUPPORT_HEADER = 'open3dfarm-api-query'
export const API_DISPATCH_QUERY_SUPPORT_HEADER = 'open3dfarm-api-dispatch-query'
export const API_SPOOL_QUERY_SUPPORT_HEADER = 'open3dfarm-api-spool-query'
export const MAX_API_QUERY_ITEMS = 200
export const MAX_API_QUERY_PAGE = 100
export const MAX_API_QUERY_RESULT_BYTES = 5500

export const ApiQueryKind = z.enum(['files', 'macros', 'dispatch'])
export type ApiQueryKind = z.infer<typeof ApiQueryKind>
export const apiQueryScopes = {
  files: 'files:read',
  macros: 'control:extended',
  dispatch: 'jobs:read',
} as const

const queryEnvelope = {
  v: z.literal(1),
  t: z.literal('connector.api-query'),
  request_id: BrowserDeviceUuid,
}
const spoolIdentity = {
  serviceId: BrowserDeviceUuid,
  spoolId: z.number().int().positive().safe(),
}

const PrinterApiQueryRequest = z.strictObject({
  ...queryEnvelope,
  assignment_id: BrowserDeviceUuid,
  kind: ApiQueryKind,
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_API_QUERY_ITEMS - 1),
  limit: z.number().int().min(1).max(MAX_API_QUERY_PAGE),
})
const SpoolApiQueryRequest = z.strictObject({
  ...queryEnvelope,
  kind: z.literal('spool-membership'),
  farmId: BrowserDeviceUuid,
  ...spoolIdentity,
})
export const ApiQueryRequest = z.discriminatedUnion('kind', [
  PrinterApiQueryRequest,
  SpoolApiQueryRequest,
])
export type ApiQueryRequest = z.infer<typeof ApiQueryRequest>
export type ApiQueryInput =
  | Omit<z.infer<typeof PrinterApiQueryRequest>, keyof typeof queryEnvelope>
  | Omit<z.infer<typeof SpoolApiQueryRequest>, keyof typeof queryEnvelope>

export const ApiSpoolMembership = z.strictObject({
  kind: z.literal('spool-membership'),
  ...spoolIdentity,
  present: z.boolean(),
  observedAt: z.number().int().nonnegative(),
})
export type ApiSpoolMembership = z.infer<typeof ApiSpoolMembership>

export const ApiQueryFile = z.strictObject({
  name: PrinterFile.shape.name,
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  estimatedSeconds: z.number().finite().nonnegative().optional(),
})
export const ApiQueryMacro = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
})

export const ApiDispatchObservation = z.strictObject({
  printerState: z.enum(['idle', 'busy', 'not-ready']),
  plateState: z.enum(['awaiting-collection', 'operator-confirmed', 'unknown']),
  attemptId: z.string().min(1).max(256).optional(),
  observedAt: z.number().int().nonnegative(),
})
export type ApiDispatchObservation = z.infer<typeof ApiDispatchObservation>

const page = {
  nextOffset: z
    .number()
    .int()
    .min(1)
    .max(MAX_API_QUERY_ITEMS - 1)
    .nullable(),
}

export const ApiQueryResult = z.discriminatedUnion('kind', [
  ApiSpoolMembership,
  z.strictObject({
    kind: z.literal('files'),
    ...page,
    data: z.array(ApiQueryFile).max(MAX_API_QUERY_PAGE),
  }),
  z.strictObject({
    kind: z.literal('macros'),
    ...page,
    data: z.array(ApiQueryMacro).max(MAX_API_QUERY_PAGE),
  }),
  z.strictObject({
    kind: z.literal('dispatch'),
    nextOffset: z.null(),
    data: z.tuple([ApiDispatchObservation]),
  }),
  z.strictObject({
    kind: z.literal('error'),
    error: z.enum(['unsupported', 'connector-unavailable']),
  }),
])
export type ApiQueryResult = z.infer<typeof ApiQueryResult>

export const ApiQueryReply = z.strictObject({
  v: z.literal(1),
  t: z.literal('connector.api-query-result'),
  request_id: BrowserDeviceUuid,
  // A nested page keeps the signalling parser's value/depth limits unchanged.
  wire: z.string().min(1).max(MAX_API_QUERY_RESULT_BYTES),
})
export type ApiQueryReply = z.infer<typeof ApiQueryReply>
