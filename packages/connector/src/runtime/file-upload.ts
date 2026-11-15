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
import { uploadCrealityFile } from '../creality/files.ts'
import type {
  createKobraLinkClient,
  PrinterBinding,
} from '../kobralink/client.ts'
import { uploadBambuFile } from '../bambu/ftps.ts'

export type FileUploadTarget =
  | { backend: 'creality'; origin: string }
  | { backend: 'anycubic' }
  | {
      backend: 'kobralink'
      client(
        signal: AbortSignal,
      ): Promise<ReturnType<typeof createKobraLinkClient>>
      binding: PrinterBinding
    }
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
  | {
      type: 'result'
      transfer_id: string
      ok: true
      library?: true | undefined
    }
  | {
      type: 'result'
      transfer_id: string
      ok: false
      reason:
        | 'unsupported'
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
    let library = false
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
        const target = input.targetFor(offer.printer_key)
        if (!target) throw Error('offline')
        if (
          target.backend === 'anycubic' ||
          ((target.backend === 'creality' || target.backend === 'kobralink') &&
            !/\.gcode$/i.test(offer.name))
        )
          throw Error('unsupported')
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
        library = target.backend === 'kobralink'
        if (target.backend === 'moonraker')
          await uploadMoonrakerFile({ ...target, ...common })
        else if (target.backend === 'bambu')
          await uploadBambuFile({ ...target, ...common })
        else if (target.backend === 'creality')
          await uploadCrealityFile({ ...target, ...common })
        else if (target.backend === 'kobralink') {
          controller.signal.throwIfAborted()
          const client = await target.client(controller.signal)
          try {
            if (closed || !authorized()) throw Error('unauthorized')
            await client.uploadFile(target.binding, filePath, common.name)
          } finally {
            client.clearSession()
          }
        } else throw Error('unsupported')
      })
      send({
        type: 'result',
        transfer_id: offer.transfer_id,
        ok: true,
        ...(library ? { library: true as const } : {}),
      } satisfies FileUploadResult)
    } catch (error) {
      await transfer?.abort()
      transfer = undefined
      const reason = controller.signal.aborted
        ? 'aborted'
        : error instanceof MoonrakerUploadError
          ? error.reason
          : error instanceof Error &&
              ['unauthorized', 'offline', 'aborted', 'unsupported'].includes(
                error.message,
              )
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
