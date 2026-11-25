import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { FileReceiver } from '../files/file-transfer.ts'
import type { PauseCapabilityHandle } from '../auth/pause-capability.ts'
import { awaitAdmittedHandle } from '../files/admission-grace.ts'
import {
  parseOffer,
  CHUNK_SIZE,
} from '../../../farm-protocol/src/file-transfer.ts'
import {
  uploadMoonrakerFile,
  MoonrakerUploadError,
} from '../moonraker/upload.ts'
import {
  resolveCrealityUploadOrigin,
  uploadCrealityFile,
} from '../creality/files.ts'
import type { resolveCrealityEndpoint } from '../discovery/creality.ts'
import { uploadSdcpFile } from '../sdcp/files.ts'
import { sdcpFileName } from '../sdcp/commands.ts'
import { readSdcpPrinterBinding } from '../control/printer-binding.ts'
import type {
  createKobraLinkClient,
  PrinterBinding,
} from '../kobralink/client.ts'
import {
  supportsAnycubicUpload,
  uploadAnycubicFile,
} from '../anycubic/files.ts'
import type { PrinterBinding as LocalPrinterBinding } from '../control/printer-binding.ts'
import { uploadBambuFile } from '../bambu/ftps.ts'

export type FileUploadTarget =
  | {
      backend: 'creality'
      origin: string
      /** The printer's WebSocket binding; decides plain or secure upload. */
      endpoint?: Parameters<typeof resolveCrealityEndpoint>[0]
    }
  | { backend: 'sdcp'; binding: LocalPrinterBinding }
  | { backend: 'anycubic'; binding?: LocalPrinterBinding }
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
      printUnsupported?: true | undefined
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
        | 'busy'
        | 'invalid-transfer'
    }
export function supportsFileUpload(
  target: FileUploadTarget,
  name: string,
  standalone = false,
): boolean {
  if (target.backend === 'sdcp') {
    const local = readSdcpPrinterBinding(target.binding)
    try {
      return !!local && !!sdcpFileName(local.model, name)
    } catch {
      return false
    }
  }
  if (target.backend === 'anycubic')
    return standalone && !!target.binding && supportsAnycubicUpload(name)
  return (
    !(target.backend === 'creality' || target.backend === 'kobralink') ||
    /\.gcode$/i.test(name)
  )
}

export async function uploadFile(input: {
  target: FileUploadTarget
  filePath: string
  name: string
  signal: AbortSignal
  authorize(): boolean
  standalone?: boolean
}): Promise<void> {
  const { target, filePath, name, signal } = input
  if (!supportsFileUpload(target, name, input.standalone))
    throw Error('unsupported')
  if (!input.authorize()) throw Error('unauthorized')
  const common = { filePath, name, signal }
  if (target.backend === 'moonraker')
    await uploadMoonrakerFile({ ...target, ...common })
  else if (target.backend === 'bambu')
    await uploadBambuFile({ ...target, ...common })
  else if (target.backend === 'sdcp')
    await uploadSdcpFile({
      ...common,
      binding: target.binding,
      authorized: input.authorize,
    })
  else if (target.backend === 'creality') {
    const destination = await resolveCrealityUploadOrigin(target)
    if (!input.authorize()) throw Error('unauthorized')
    await uploadCrealityFile({ ...destination, ...common })
  } else if (target.backend === 'anycubic' && target.binding)
    await uploadAnycubicFile({
      ...common,
      binding: target.binding,
      authorized: input.authorize,
    })
  else if (target.backend === 'kobralink') {
    signal.throwIfAborted()
    const client = await target.client(signal)
    try {
      if (!input.authorize()) throw Error('unauthorized')
      await client.uploadFile(target.binding, filePath, name)
    } finally {
      client.clearSession()
    }
  } else throw Error('unsupported')
}
const terminal = z.strictObject({ type: z.enum(['complete', 'abort']) })

// One verified payload per admitted transport, cleared on dispatch or peer close.
const stagedConfigs = new Map<
  string,
  { path: string; sha256: string; bytes: Buffer }
>()
export function consumeStagedConfig(
  transport: string,
  path: string,
  sha256: string,
) {
  const staged = stagedConfigs.get(transport)
  if (staged?.path !== path || staged.sha256 !== sha256) return undefined
  stagedConfigs.delete(transport)
  return staged.bytes
}

/** One stop-and-wait transfer per control peer. */
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
  let stagedTransport: string | undefined
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
      (offer?.config
        ? cap.actions.includes('config_write') &&
          (cap.role === 'owner' || cap.role === 'admin')
        : cap.actions.includes('start_print'))
    )
  }
  function send(value: object) {
    if (!closed) input.send(JSON.stringify(value))
  }
  async function process(raw: unknown) {
    let forwarding = false
    let library = false
    let printUnsupported = false
    try {
      if (!offer) {
        if (used || typeof raw !== 'string' || raw.length > 2048)
          throw Error('invalid-transfer')
        used = true
        offer = parseOffer(JSON.parse(raw))
        handle =
          input.admittedHandle() ??
          (await awaitAdmittedHandle(input.admittedHandle, controller.signal))
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
          offer.config
            ? target.backend !== 'moonraker'
            : !supportsFileUpload(target, offer.name, true)
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
        if (staged.offer.config) {
          const bytes = await readFile(filePath, { signal: controller.signal })
          const cap = handle?.current
          if (!cap || closed || !authorized()) throw Error('unauthorized')
          stagedTransport = cap.transport_id
          stagedConfigs.set(stagedTransport, {
            path: staged.offer.name,
            sha256: staged.offer.sha256,
            bytes,
          })
          return
        }
        forwarding = true
        library = target.backend === 'kobralink'
        printUnsupported = target.backend === 'anycubic'
        await uploadFile({
          target,
          filePath,
          name: staged.offer.name,
          signal: controller.signal,
          authorize: () => !closed && authorized(),
          standalone: true,
        })
      })
      send({
        type: 'result',
        transfer_id: offer.transfer_id,
        ok: true,
        ...(library ? { library: true as const } : {}),
        ...(printUnsupported ? { printUnsupported: true as const } : {}),
      } satisfies FileUploadResult)
    } catch (error) {
      await transfer?.abort()
      transfer = undefined
      const reason = controller.signal.aborted
        ? 'aborted'
        : error instanceof MoonrakerUploadError
          ? error.reason
          : error instanceof Error &&
              [
                'unauthorized',
                'offline',
                'aborted',
                'unsupported',
                'busy',
              ].includes(error.message)
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
    /**
     * Ends the handler. The browser closes the file channel as soon as a
     * transfer is done, and the staged config must outlive that: the signed
     * `config_write` that consumes it arrives afterwards on the control
     * channel. `keepStaged` is for that channel close; the peer's own close
     * clears the staged payload.
     */
    async close(options?: { keepStaged?: boolean }) {
      closed = true
      if (stagedTransport && !options?.keepStaged)
        stagedConfigs.delete(stagedTransport)
      controller.abort()
      await transfer?.abort()
      transfer = undefined
    },
    async settled() {
      await work
    },
  }
}
