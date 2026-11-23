import { z } from 'zod'
import { ConfigFileName, PrinterGcodePath } from './control-actions.ts'

export const MAX_FILE_LIST_WIRE_BYTES = 256 * 1024
export const MAX_PRINTER_DOWNLOAD_BYTES = 128 * 1024
/** A rendered timelapse is read in 16 KiB steps and never exceeds this size. */
export const MAX_TIMELAPSE_BYTES = 32 * 1024 * 1024
export const TIMELAPSE_CHUNK_BYTES = 16 * 1024
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const FileListRequest = z
  .strictObject({
    type: z.literal('files.list'),
    request_id: id,
    printer_key: id,
    config: z.literal(true).optional(),
    configPath: ConfigFileName.optional(),
    /** Reads one chunk of a rendered timelapse named by `download`. */
    timelapse: z.literal(true).optional(),
    offset: z.number().int().min(0).max(MAX_TIMELAPSE_BYTES).optional(),
    directory: z.union([z.literal(''), PrinterGcodePath]).optional(),
    download: PrinterGcodePath.optional(),
  })
  .refine(({ directory, download, config, configPath, offset, timelapse }) =>
    config
      ? timelapse === undefined &&
        directory === undefined &&
        download === undefined &&
        (offset === undefined || configPath !== undefined) &&
        (offset ?? 0) <= 1024 * 1024
      : timelapse
        ? configPath === undefined &&
          directory === undefined &&
          download !== undefined
        : configPath === undefined &&
          offset === undefined &&
          (directory === undefined || download === undefined),
  )
const DownloadBytes = z
  .base64()
  .max(Math.ceil(MAX_PRINTER_DOWNLOAD_BYTES / 3) * 4)
  .refine(
    (data) =>
      (data.length * 3) / 4 -
        (data.endsWith('==') ? 2 : Number(data.endsWith('='))) <=
      MAX_PRINTER_DOWNLOAD_BYTES,
  )
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
  directory: z.literal(true).optional(),
  printUnsupported: z.literal(true).optional(),
  printRef: z
    .string()
    .max(255)
    .refine(
      (ref) =>
        /^kobralink-library:[A-Za-z0-9_-]{1,128}$/.test(ref) ||
        (ref.startsWith('creality-udisk:') &&
          /^creality-udisk:[A-Za-z0-9_][A-Za-z0-9_. -]*\.gcode$/i.test(ref) &&
          !ref.includes('..')),
    )
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
export type PrinterFile = z.infer<typeof PrinterFile>
export const FileListResponse = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('files.list.result'),
    request_id: id,
    printer_key: id,
    ok: z.literal(true),
    download: DownloadBytes.optional(),
    /** Size and digest of the timelapse a chunk belongs to. */
    transfer: z
      .strictObject({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().min(0).max(MAX_TIMELAPSE_BYTES),
      })
      .optional(),
    config: z
      .strictObject({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z
          .number()
          .int()
          .min(0)
          .max(1024 * 1024),
        backups: z.array(z.string().max(224)).max(10),
      })
      .optional(),
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
/** Extra request fields beyond a plain listing or gcodes download. */
export type FileListExtra =
  | { config: true; configPath?: string; offset?: number }
  | { timelapse: true; offset?: number }
export type FileListResult = z.infer<typeof FileListResponse>
