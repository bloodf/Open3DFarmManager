import { z } from 'zod'
import { FileReceiver } from '../files/file-transfer.ts'
import type { PauseCapabilityHandle } from '../auth/pause-capability.ts'
import {
  parseOffer,
  CHUNK_SIZE,
} from '../../../farm-protocol/src/file-transfer.ts'
import {
  uploadMoonrakerFile,
  MoonrakerUploadError,
} from '../moonraker/upload.ts'
import { uploadBambuFile } from '../bambu/ftps.ts'

export type FileUploadTarget =
  | { backend: 'moonraker'; origin: string; apiKey?: string }
  | ({ backend: 'bambu' } & Omit<
      Parameters<typeof uploadBambuFile>[0],
      'filePath' | 'name' | 'signal'
    >)
export type FileUploadOptions = Readonly<{
  directory: string
  targetFor(printerKey: string): FileUploadTarget | undefined
}>
export type FileUploadResult =
  | { type: 'result'; transfer_id: string; ok: true }
  | {
      type: 'result'
      transfer_id: string
      ok: false
      reason:
        | 'unauthorized'
        | 'too-large'
        | 'timeout'
        | 'aborted'
        | 'offline'
        | 'invalid-transfer'
    }
const terminal = z.strictObject({ type: z.enum(['complete', 'abort']) })

/** One stop-and-wait transfer per control peer. No remote destination or credential is accepted. */
export function createFileUpload(
  input: FileUploadOptions & {
    admittedHandle(): PauseCapabilityHandle | undefined
    send(wire: string): void
  },
) {
  const receiver = new FileReceiver(input.directory)
  const controller = new AbortController()
  let transfer: Awaited<ReturnType<FileReceiver['offer']>> | undefined
  let offer: ReturnType<typeof parseOffer> | undefined
  let handle: PauseCapabilityHandle | undefined
  let used = false
  let busy = false
  let work: Promise<void> = Promise.resolve()
  let closed = false
  function authorized(): boolean {
    const current = input.admittedHandle()
    const cap = current?.current
    return (
      !!cap &&
      current === handle &&
      cap.printer_key === offer?.printer_key &&
      cap.actions.includes('start_print')
    )
  }
  function send(value: object) {
    if (!closed) input.send(JSON.stringify(value))
  }
  async function process(raw: unknown) {
    let forwarding = false
    try {
      if (!offer) {
        if (used || typeof raw !== 'string' || raw.length > 2048)
          throw Error('invalid-transfer')
        used = true
        offer = parseOffer(JSON.parse(raw))
        handle = input.admittedHandle()
        if (!authorized()) {
          send({
            type: 'result',
            transfer_id: offer.transfer_id,
            ok: false,
            reason: 'unauthorized',
          } satisfies FileUploadResult)
          return
        }
        if (!input.targetFor(offer.printer_key)) throw Error('offline')
        transfer = await receiver.offer(offer)
        if (closed || !authorized()) throw Error('unauthorized')
        send({ type: 'accept' })
        return
      }
      if (!transfer || !authorized()) throw Error('unauthorized')
      if (raw instanceof Uint8Array) {
        if (raw.byteLength < 5 || raw.byteLength > CHUNK_SIZE + 4)
          throw Error('invalid-transfer')
        const sequence = new DataView(
          raw.buffer,
          raw.byteOffset,
          raw.byteLength,
        ).getUint32(0)
        await transfer.chunk(sequence, raw.subarray(4))
        send({ type: 'ack' })
        return
      }
      if (typeof raw !== 'string' || raw.length > 64)
        throw Error('invalid-transfer')
      const message = terminal.parse(JSON.parse(raw))
      if (message.type === 'abort') throw Error('aborted')
      const staged = await transfer.complete()
      transfer = undefined
      await staged.forward(async (filePath) => {
        if (closed || !authorized()) throw Error('unauthorized')
        const target = input.targetFor(staged.offer.printer_key)
        if (!target) throw Error('offline')
        const common = {
          filePath,
          name: staged.offer.name,
          signal: controller.signal,
        }
        forwarding = true
        if (target.backend === 'moonraker')
          await uploadMoonrakerFile({ ...target, ...common })
        else await uploadBambuFile({ ...target, ...common })
      })
      send({
        type: 'result',
        transfer_id: offer.transfer_id,
        ok: true,
      } satisfies FileUploadResult)
    } catch (error) {
      await transfer?.abort()
      transfer = undefined
      const reason = controller.signal.aborted
        ? 'aborted'
        : error instanceof MoonrakerUploadError
          ? error.reason
          : error instanceof Error &&
              ['unauthorized', 'offline', 'aborted'].includes(error.message)
            ? error.message
            : forwarding
              ? 'offline'
              : 'invalid-transfer'
      send({
        type: 'result',
        transfer_id: offer?.transfer_id ?? '',
        ok: false,
        reason,
      })
    }
  }
  return {
    receive(raw: unknown) {
      if (closed) return
      if (busy) {
        void this.close()
        return
      }
      busy = true
      work = process(raw)
        .catch(() => this.close())
        .finally(() => {
          busy = false
        })
    },
    async close() {
      closed = true
      controller.abort()
      await transfer?.abort()
      transfer = undefined
    },
    async settled() {
      await work
    },
  }
}
