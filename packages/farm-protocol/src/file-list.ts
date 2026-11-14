import { z } from 'zod'

export const MAX_FILE_LIST_WIRE_BYTES = 256 * 1024
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const FileListRequest = z.strictObject({
  type: z.literal('files.list'),
  request_id: id,
  printer_key: id,
})
export const PrinterFile = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) =>
        !/[\\\u0000-\u001f\u007f-\u009f]/.test(name) &&
        !name.startsWith('/') &&
        !name.split('/').some((part) => part === '..' || part === '.' || !part),
    ),
  size: z.number().finite().nonnegative(),
  modified: z.number().finite().nonnegative(),
  estimatedTime: z.number().finite().nonnegative().optional(),
})
export const FileListResponse = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('files.list.result'),
    request_id: id,
    printer_key: id,
    ok: z.literal(true),
    files: z.array(PrinterFile).max(200),
  }),
  z.strictObject({
    type: z.literal('files.list.result'),
    request_id: id,
    printer_key: id,
    ok: z.literal(false),
    reason: z.enum(['unauthorized', 'offline', 'busy']),
  }),
])
export type FileListResult = z.infer<typeof FileListResponse>
