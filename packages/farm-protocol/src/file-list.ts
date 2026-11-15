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
  printRef: z
    .string()
    .regex(/^kobralink-library:[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  size: z.number().finite().nonnegative(),
  modified: z.number().finite().nonnegative(),
  thumbnail: z
    .string()
    .max(87384)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((value) => {
      try {
        const bytes = atob(value)
        return bytes.length <= 65536 && bytes.startsWith('\x89PNG\r\n\x1a\n')
      } catch {
        return false
      }
    })
    .optional(),
  estimatedTime: z.number().finite().nonnegative().optional(),
})
export const FileListResponse = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('files.list.result'),
    request_id: id,
    printer_key: id,
    ok: z.literal(true),
    files: z
      .array(PrinterFile)
      .max(200)
      .refine(
        (files) =>
          files.filter((file) => file.thumbnail !== undefined).length <= 50,
      ),
  }),
  z.strictObject({
    type: z.literal('files.list.result'),
    request_id: id,
    printer_key: id,
    ok: z.literal(false),
    reason: z.enum(['unauthorized', 'offline', 'busy', 'unsupported']),
  }),
])
export type FileListResult = z.infer<typeof FileListResponse>
