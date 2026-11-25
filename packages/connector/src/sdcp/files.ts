/**
 * Chunked HTTP upload to the printer's internal storage:
 * `POST /uploadFile/upload`, multipart, 1 MiB per request, whole-file MD5.
 * - cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215, "Mainboard
 *   HTTP Server Interface Definition" (resin boards, port 3030).
 * - ELEGOO-3D/elegoo-link @ ec2d226,
 *   src/lan/adapters/elegoo_fdm_cc/elegoo_fdm_cc_http_transfer.cpp and
 *   bjan/pycentauri @ 2f6d9ed, src/pycentauri/upload.py (Centauri Carbon,
 *   port 80).
 *
 * One attempt per chunk: a failed or uncertain chunk ends the upload. MD5 is
 * the protocol's integrity check, not a security measure. The LAN transfer is
 * unauthenticated and unencrypted.
 */
import { createHash, randomBytes } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import {
  readSdcpPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { sdcpFileName } from './commands.ts'
import { resolveSdcpTarget } from './identity.ts'
import { sdcpProfile } from './models.ts'

export const SDCP_CHUNK_BYTES = 1024 * 1024
export const SDCP_MAX_FILE_BYTES = 512 * 1024 * 1024

async function readChunk(handle: FileHandle, offset: number, length: number) {
  const chunk = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(
      chunk,
      read,
      length - read,
      offset + read,
    )
    if (!bytesRead) throw new Error('Staged file changed during upload')
    read += bytesRead
  }
  return chunk
}

export async function uploadSdcpFile(input: {
  binding: PrinterBinding
  filePath: string
  name: string
  signal: AbortSignal
  /** Rechecked before the identity probe and before every chunk. */
  authorized(): boolean
}): Promise<void> {
  const check = () => {
    input.signal.throwIfAborted()
    const local = readSdcpPrinterBinding(input.binding)
    if (!local || !input.authorized()) throw new Error('unauthorized')
    return local
  }
  const local = check()
  const profile = sdcpProfile(local.model)
  if (!profile) throw new Error('unsupported')
  const name = sdcpFileName(local.model, input.name)
  const handle = await open(input.filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || !stat.size || stat.size > SDCP_MAX_FILE_BYTES)
      throw new Error('Invalid SDCP staged file size')
    const digest = createHash('md5')
    for (let offset = 0; offset < stat.size; offset += SDCP_CHUNK_BYTES)
      digest.update(
        await readChunk(
          handle,
          offset,
          Math.min(SDCP_CHUNK_BYTES, stat.size - offset),
        ),
      )
    const md5 = digest.digest('hex')
    const uuid = randomBytes(16).toString('hex')
    await resolveSdcpTarget(check(), {
      ...(local.discoveryPort ? { port: local.discoveryPort } : {}),
      signal: input.signal,
    })
    const url = `http://${local.host}:${local.uploadPort ?? profile.uploadPort}/uploadFile/upload`
    for (let offset = 0; offset < stat.size; offset += SDCP_CHUNK_BYTES) {
      const chunk = await readChunk(
        handle,
        offset,
        Math.min(SDCP_CHUNK_BYTES, stat.size - offset),
      )
      const form = new FormData()
      form.set('Check', '1')
      form.set('S-File-MD5', md5)
      form.set('Offset', String(offset))
      form.set('Uuid', uuid)
      form.set('TotalSize', String(stat.size))
      form.set(
        'File',
        new Blob([new Uint8Array(chunk)], {
          type: 'application/octet-stream',
        }),
        name,
      )
      check()
      const response = await fetch(url, {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]),
      })
      const body = (await response.text()).slice(0, 4096)
      let code: unknown
      try {
        code = JSON.parse(body).code
      } catch {
        /* a non-JSON reply is a rejection */
      }
      if (response.status !== 200 || code !== '000000')
        throw new Error(`SDCP upload rejected at offset ${offset}`)
    }
  } finally {
    await handle.close()
  }
}
