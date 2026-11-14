import {
  FileListRequest,
  FileListResponse,
  PrinterFile,
  MAX_FILE_LIST_WIRE_BYTES,
} from '../../../farm-protocol/src/file-list.ts'
import type { PauseCapabilityHandle } from '../auth/pause-capability.ts'
import {
  listMoonrakerFiles,
  type MoonrakerFilesClient,
} from '../moonraker/files.ts'
import { listBambuFiles, type BambuListOptions } from '../bambu/files.ts'

export type FileListTarget =
  | { backend: 'moonraker'; client: MoonrakerFilesClient }
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
      const handle = input.admittedHandle()
      const authorized = () => {
        const current = input.admittedHandle()
        const cap = current?.current
        return (
          !!handle &&
          current === handle &&
          cap?.printer_key === request.printer_key &&
          cap.actions.includes('start_print')
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
      if (!authorized()) {
        send({ ok: false, reason: 'unauthorized' })
        return true
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
          const target = input.targetFor(request.printer_key)
          if (!target) throw Error('offline')
          const entries =
            target.backend === 'moonraker'
              ? await Promise.race([
                  listMoonrakerFiles(target.client, { limit: 200 }),
                  deadline,
                ])
              : (
                  await Promise.race([
                    listBambuFiles({ ...target, signal: controller.signal }),
                    deadline,
                  ])
                ).map(({ name, size, modifiedAt }) => ({
                  name,
                  size,
                  modified: Date.parse(modifiedAt) / 1000,
                }))
          const files = entries
            .flatMap((entry) => {
              const file = PrinterFile.safeParse(entry)
              return file.success ? [file.data] : []
            })
            .slice(0, 200)
          send(
            authorized()
              ? { ok: true, files }
              : { ok: false, reason: 'unauthorized' },
          )
        } catch {
          send({ ok: false, reason: authorized() ? 'offline' : 'unauthorized' })
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
