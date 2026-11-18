import { z } from 'zod'
import { BrowserDeviceUuid } from './browser-device-proof.ts'
import { PrinterFile } from './file-list.ts'

export const API_QUERY_SUPPORT_HEADER = 'open3dfarm-api-query'
export const MAX_API_QUERY_ITEMS = 200
export const MAX_API_QUERY_PAGE = 100
export const MAX_API_QUERY_RESULT_BYTES = 5500

export const ApiQueryKind = z.enum(['files', 'macros'])
export type ApiQueryKind = z.infer<typeof ApiQueryKind>
export const apiQueryScopes = {
  files: 'files:read',
  macros: 'control:extended',
} as const

export const ApiQueryRequest = z.strictObject({
  v: z.literal(1),
  t: z.literal('connector.api-query'),
  request_id: BrowserDeviceUuid,
  assignment_id: BrowserDeviceUuid,
  kind: ApiQueryKind,
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_API_QUERY_ITEMS - 1),
  limit: z.number().int().min(1).max(MAX_API_QUERY_PAGE),
})
export type ApiQueryRequest = z.infer<typeof ApiQueryRequest>

export const ApiQueryFile = z.strictObject({
  name: PrinterFile.shape.name,
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  estimatedSeconds: z.number().finite().nonnegative().optional(),
})
export const ApiQueryMacro = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
})

const page = {
  nextOffset: z
    .number()
    .int()
    .min(1)
    .max(MAX_API_QUERY_ITEMS - 1)
    .nullable(),
}

export const ApiQueryResult = z.discriminatedUnion('kind', [
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
