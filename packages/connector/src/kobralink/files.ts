import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { MAX_FILE_SIZE } from '../../../farm-protocol/src/file-transfer.ts'

// NatHacks/Kobralink 5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1:
// apps/api/src/core/core.controller.ts: GET printer-files, POST files,
// POST printer-files/print; packages/shared/src/files.ts: PrinterFileDto.
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !/[\\/\x00-\x1f\x7f]/.test(v) && !v.includes('..'))
const printerFiles = z
  .array(
    z.object({
      filename,
      sizeBytes: z.number().int().nonnegative().safe(),
      timestamp: z.number().finite().nonnegative(),
    }),
  )
  .max(200)

export function parseKobraLinkFiles(value: unknown) {
  return printerFiles.parse(value)
}

/** Uploads to the bridge's library. It does not start a print. */
export async function kobraLinkUploadBody(filePath: string, name: string) {
  filename.regex(/\.(gcode|bgcode)$/i).parse(name)
  const info = await stat(filePath)
  if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_SIZE)
    throw new Error('Invalid staged file size')
  const bytes = await readFile(filePath)
  if (bytes.byteLength !== info.size || bytes.byteLength > MAX_FILE_SIZE)
    throw new Error('Staged file changed')
  const body = new FormData()
  body.append('file', new Blob([bytes]), name)
  body.append('print', 'false')
  return body
}

// packages/shared/src/files.ts: GcodeFileDto and startPrintSchema at the same pin.
const libraryFiles = z
  .array(
    z.object({
      id: z.string().min(1).max(128),
      filename,
      sizeBytes: z.number().int().nonnegative().safe(),
    }),
  )
  .max(200)
export function parseKobraLinkLibrary(value: unknown) {
  return libraryFiles.parse(value)
}
