import { createMoonrakerConfigEditor } from '../moonraker/control-config-editor.ts'
import { createHash } from 'node:crypto'
import { moonrakerAuthHeaders } from '../config/moonraker.ts'
import {
  FileListRequest,
  FileListResponse,
  PrinterFile,
  MAX_FILE_LIST_WIRE_BYTES,
  MAX_PRINTER_DOWNLOAD_BYTES,
  MAX_TIMELAPSE_BYTES,
  TIMELAPSE_CHUNK_BYTES,
} from '../../../farm-protocol/src/file-list.ts'
import type { PauseCapabilityHandle } from '../auth/pause-capability.ts'
import { awaitAdmittedHandle } from '../files/admission-grace.ts'
import {
  listMoonrakerFiles,
  createThumbnailDownload,
  type MoonrakerFilesClient,
} from '../moonraker/files.ts'
import type {
  createKobraLinkClient,
  PrinterBinding as KobraLinkPrinterBinding,
} from '../kobralink/client.ts'
import { listBambuFiles, type BambuListOptions } from '../bambu/files.ts'
import { listAnycubicFiles } from '../anycubic/files.ts'
import type { PrinterBinding } from '../control/printer-binding.ts'
import { createBambuSdCard } from '../bambu/printer-detail.ts'
import { listCrealityFiles } from '../creality/files.ts'

export type FileListTarget =
  | { backend: 'creality'; binding?: PrinterBinding }
  | { backend: 'anycubic'; binding?: PrinterBinding }
  | {
      backend: 'kobralink'
      client(
        signal: AbortSignal,
      ): Promise<ReturnType<typeof createKobraLinkClient>>
      binding: KobraLinkPrinterBinding
    }
  | {
      backend: 'moonraker'
      client: MoonrakerFilesClient
      thumbnailSource?: {
        origin: string
        limits: import('../config/moonraker.ts').MoonrakerLimits
      }
    }
  | ({ backend: 'bambu' } & Omit<BambuListOptions, 'signal'>)
export type FileListOptions = Readonly<{
  targetFor(printerKey: string): FileListTarget | undefined
}>

export function createFileList(
  input: FileListOptions & {
    admittedHandle(): PauseCapabilityHandle | undefined
    send(wire: string): void
  },
) {
  let configSnapshot:
    | {
        path: string
        value: Awaited<
          ReturnType<ReturnType<typeof createMoonrakerConfigEditor>['read']>
        >
      }
    | undefined
  let timelapseSnapshot:
    { name: string; bytes: Buffer; sha256: string } | undefined
  let closed = false
  let busy = false
  let work: Promise<void> = Promise.resolve()
  const controller = new AbortController()
  return {
    receive(raw: unknown): boolean {
      if (typeof raw !== 'string' || raw.length > 2048) return false
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        return false
      }
      const parsed = FileListRequest.safeParse(value)
      if (!parsed.success) return false
      if (closed) return true
      const request = parsed.data
      let handle = input.admittedHandle()
      const authorized = () => {
        const current = input.admittedHandle()
        const cap = current?.current
        return (
          !!handle &&
          current === handle &&
          cap?.printer_key === request.printer_key &&
          (request.config
            ? cap.actions.includes('config_write') &&
              (cap.role === 'owner' || cap.role === 'admin')
            : request.timelapse
              ? cap.actions.includes('timelapse') ||
                cap.actions.includes('file_op')
              : cap.actions.includes(
                  request.directory === undefined &&
                    request.download === undefined
                    ? 'start_print'
                    : 'file_op',
                ))
        )
      }
      const send = (result: object) => {
        if (!closed) {
          const wire = JSON.stringify(
            FileListResponse.parse({
              type: 'files.list.result',
              request_id: request.request_id,
              printer_key: request.printer_key,
              ...result,
            }),
          )
          if (
            new TextEncoder().encode(wire).byteLength > MAX_FILE_LIST_WIRE_BYTES
          )
            throw Error('File list too large')
          input.send(wire)
        }
      }
      if (busy) {
        send({ ok: false, reason: 'busy' })
        return true
      }
      busy = true
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: () => void = () => {}
      const deadline = new Promise<never>((_resolve, reject) => {
        abort = () => reject(Error('File list closed'))
        controller.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(Error('File list timeout')), 30000)
      })
      work = (async () => {
        try {
          handle ??= await awaitAdmittedHandle(
            input.admittedHandle,
            controller.signal,
          )
          if (!authorized()) {
            send({ ok: false, reason: 'unauthorized' })
            return
          }
          const target = input.targetFor(request.printer_key)
          if (!target) throw Error('offline')
          if (request.timelapse && request.download) {
            const offset = request.offset ?? 0
            if (offset === 0 || timelapseSnapshot?.name !== request.download) {
              if (offset !== 0) throw Error('unsupported')
              const bytes = await Promise.race([
                readTimelapse(target, request.download, controller.signal),
                deadline,
              ])
              timelapseSnapshot = {
                name: request.download,
                bytes,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              }
            }
            const { bytes, sha256 } = timelapseSnapshot
            if (offset > bytes.length) throw Error('unsupported')
            send(
              authorized()
                ? {
                    ok: true,
                    files: [],
                    download: bytes
                      .subarray(offset, offset + TIMELAPSE_CHUNK_BYTES)
                      .toString('base64'),
                    transfer: { size: bytes.length, sha256 },
                  }
                : { ok: false, reason: 'unauthorized' },
            )
            return
          }
          if (request.config) {
            if (target.backend !== 'moonraker' || !target.thumbnailSource)
              throw Error('unsupported')
            const { origin, limits } = target.thumbnailSource
            const editor = createMoonrakerConfigEditor(
              origin,
              moonrakerAuthHeaders(origin, limits)['X-Api-Key'],
            )
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ])
            if (!request.configPath) {
              const names = await editor.list(signal)
              send(
                authorized()
                  ? {
                      ok: true,
                      files: names
                        .slice(0, 200)
                        .map((name) => ({ name, size: 0, modified: 0 })),
                    }
                  : { ok: false, reason: 'unauthorized' },
              )
              return
            }
            const offset = request.offset ?? 0
            if (offset === 0)
              configSnapshot = {
                path: request.configPath,
                value: await editor.read(request.configPath, signal),
              }
            if (
              configSnapshot?.path !== request.configPath ||
              offset > configSnapshot.value.bytes.length
            )
              throw Error('unsupported')
            const { bytes, sha256, backups } = configSnapshot.value
            send(
              authorized()
                ? {
                    ok: true,
                    files: [],
                    download: Buffer.from(
                      bytes.subarray(offset, offset + 16384),
                    ).toString('base64'),
                    config: {
                      sha256,
                      size: bytes.length,
                      backups: backups.slice(0, 10),
                    },
                  }
                : { ok: false, reason: 'unauthorized' },
            )
            return
          }
          if (request.download) {
            if (target.backend !== 'moonraker' || !target.thumbnailSource)
              throw Error('unsupported')
            const download = await Promise.race([
              readPrinterDownload(
                createThumbnailDownload({
                  ...target.thumbnailSource,
                  signal: controller.signal,
                }),
                request.download,
              ),
              deadline,
            ])
            send(
              authorized()
                ? { ok: true, files: [], download }
                : { ok: false, reason: 'unauthorized' },
            )
            return
          }
          const entries = await Promise.race([
            readPrinterFiles(target, {
              signal: controller.signal,
              authorized,
              previews: true,
              directory: request.directory,
            }),
            deadline,
          ])
          const files = entries
            .flatMap((entry) => {
              const file = PrinterFile.safeParse(entry)
              return file.success ? [file.data] : []
            })
            .slice(0, 200)
          if (
            target.backend === 'kobralink' &&
            new Set(files.map((file) => file.name)).size !== files.length
          )
            throw Error('Ambiguous library filenames')
          // Preserve the existing channel bound, retaining the newest previews first.
          for (let i = files.length - 1; i >= 0; i--) {
            if (
              new TextEncoder().encode(
                JSON.stringify({
                  type: 'files.list.result',
                  request_id: request.request_id,
                  printer_key: request.printer_key,
                  ok: true,
                  files,
                }),
              ).byteLength <= MAX_FILE_LIST_WIRE_BYTES
            )
              break
            const file = files[i]
            if (file) delete file.thumbnail
          }
          send(
            authorized()
              ? { ok: true, files }
              : { ok: false, reason: 'unauthorized' },
          )
        } catch (error) {
          send({
            ok: false,
            reason: !authorized()
              ? 'unauthorized'
              : error instanceof Error && error.message === 'unsupported'
                ? 'unsupported'
                : 'offline',
          })
        }
      })()
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', abort)
          busy = false
        })
      return true
    },
    close() {
      closed = true
      controller.abort()
    },
    async settled() {
      await work
    },
  }
}

/** Reads one rendered timelapse whole; every chunk is then served from memory. */
async function readTimelapse(
  target: FileListTarget,
  name: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (target.backend === 'bambu') {
    const data = await createBambuSdCard(target).download(
      'timelapse',
      name.replace(/^timelapse\//, ''),
      signal,
    )
    if (data.length > MAX_TIMELAPSE_BYTES) throw Error('File too large')
    return data
  }
  if (target.backend !== 'moonraker' || !target.thumbnailSource)
    throw Error('unsupported')
  const response = await createThumbnailDownload({
    ...target.thumbnailSource,
    signal,
  })(`timelapse/${name}`)
  const reader = response.body?.getReader()
  if (!reader) throw Error('File unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (
      !response.ok ||
      Number(response.headers.get('content-length')) > MAX_TIMELAPSE_BYTES
    )
      throw Error('File unavailable')
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_TIMELAPSE_BYTES) throw Error('File too large')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function readPrinterDownload(
  fetchFile: (path: string) => Promise<Response>,
  path: string,
): Promise<string> {
  const response = await fetchFile(`gcodes/${path}`)
  const reader = response.body?.getReader()
  if (!reader) throw Error('File unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (
      !response.ok ||
      Number(response.headers.get('content-length')) >
        MAX_PRINTER_DOWNLOAD_BYTES
    )
      throw Error('File unavailable')
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_PRINTER_DOWNLOAD_BYTES) throw Error('File too large')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks).toString('base64')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readPrinterFiles(
  target: FileListTarget,
  input: {
    signal: AbortSignal
    authorized(): boolean
    previews: boolean
    directory?: string | undefined
  },
) {
  if (input.directory !== undefined && target.backend !== 'moonraker')
    throw Error('unsupported')
  switch (target.backend) {
    case 'creality':
      if (!target.binding) throw Error('unsupported')
      return listCrealityFiles({ ...input, binding: target.binding })
    case 'anycubic':
      if (!target.binding) throw Error('unsupported')
      return listAnycubicFiles({ binding: target.binding, ...input })
    case 'kobralink': {
      const client = await target.client(input.signal)
      try {
        if (!input.authorized()) throw Error('unauthorized')
        return (await client.listLibraryFiles(target.binding)).map((file) => ({
          name: file.filename,
          size: file.sizeBytes,
          modified: 0,
          printRef: `kobralink-library:${file.id}`,
        }))
      } finally {
        client.clearSession()
      }
    }
    case 'moonraker':
      return listMoonrakerFiles(
        {
          request: (method, params) =>
            target.client.request(method, params, input.signal),
          ...(input.previews && target.thumbnailSource
            ? {
                downloadThumbnail: createThumbnailDownload({
                  ...target.thumbnailSource,
                  signal: input.signal,
                }),
              }
            : input.previews && target.client.downloadThumbnail
              ? {
                  downloadThumbnail: (path) =>
                    target.client.downloadThumbnail!(path),
                }
              : {}),
        },
        { limit: 200, metadata: input.previews, directory: input.directory },
      )
    case 'bambu':
      return (await listBambuFiles({ ...target, signal: input.signal })).map(
        ({ name, size, modifiedAt }) => ({
          name,
          size,
          modified: Date.parse(modifiedAt) / 1000,
        }),
      )
  }
}
