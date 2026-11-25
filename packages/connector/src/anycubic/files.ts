import { randomUUID } from 'node:crypto'
import { openAsBlob, readFileSync } from 'node:fs'
import { z } from 'zod'
import { isAnycubicStartFile } from '../../../farm-protocol/src/control-actions.ts'
import type { PrinterFile } from '../../../farm-protocol/src/file-list.ts'
import { MAX_FILE_SIZE } from '../../../farm-protocol/src/file-transfer.ts'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import { readKobraClientCertMaterial } from '../config/kobra-x-cert.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import {
  readAnycubicPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { createAnycubicControlTransport } from './control-transport.ts'

export const ANYCUBIC_FILE_MODEL = '20024'
const FIRMWARE = '2.4.6.7'
const FRAME_LIMIT = 131072
// Wire format. Topics and `listLocal`/`/gcode_upload`:
// rvanderp3/kobra-connect@3edba24606d7122c4a68accd09af937ba4fdbd08
// docs/mqtt-commands.md §13 and §16 (model 20024 topics).
// Request fields, reply states, millisecond timestamps, `is_dir` records and
// the upload parts: bloodf/kobracontrol@c414db4f36d4c96f2b232c368ad6cfe56e3d0408
// docs/protocol.md "Files on the printer" and src/kobracontrol/kobra.py
// (`LIST_DATA`, `_file_records`, `_seconds`, `_upload`). Observed there on a
// Kobra X; the Kobra 3 is "experimental" and nothing was captured on one.
const LIST_ROOT = { page_num: 1, page_size: 200, path: '/' } as const
type ListRoot = typeof LIST_ROOT
const MQTT_ROOT = 'anycubic/anycubicCloud/v1'
const Report = z.object({
  type: z.enum(['info', 'file']),
  action: z.string(),
  msgid: z.string(),
  state: z.string(),
  code: z.number(),
  data: z.unknown(),
})
const Info = z.object({
  version: z.string(),
  state: z.string(),
  project: z.object({ state: z.string() }).nullish(),
  urls: z.object({ fileUploadurl: z.string().max(2048) }).optional(),
})
const FileRecord = z.object({
  filename: z.string(),
  is_dir: z.boolean(),
  size: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
})
const UploadResponse = z.object({
  code: z.literal(200),
  data: z.object({ gcode: z.string() }),
})

function validFileName(name: string) {
  return /^[^/\\%\x00-\x1f\x7f-\x9f]{1,255}$/.test(name)
}

export function supportsAnycubicUpload(name: string) {
  return validFileName(name) && /\.gcode\.3mf$/i.test(name)
}

type FileRequest = {
  binding: PrinterBinding
  signal: AbortSignal
  authorized(): boolean
}

function localBinding(binding: PrinterBinding) {
  const local = readAnycubicPrinterBinding(binding)
  if (local?.modelId !== ANYCUBIC_FILE_MODEL) throw Error('unsupported')
  return local
}

function enforceAuthorization(
  input: FileRequest,
  local: ReturnType<typeof localBinding>,
) {
  input.signal.throwIfAborted()
  if (
    readAnycubicPrinterBinding(input.binding) !== local ||
    !input.authorized()
  )
    throw Error('unauthorized')
}

// File requests use their own short-lived broker connection. A reply must match
// the bound topic and this request's ID. A disconnect ends the attempt.
async function withFileSession<T>(
  input: FileRequest,
  operation: (
    info: z.infer<typeof Info>,
    request: (
      type: 'info' | 'file',
      action: 'query' | 'listLocal',
      data: null | ListRoot,
    ) => Promise<unknown>,
    local: ReturnType<typeof localBinding>,
  ) => Promise<T>,
): Promise<T> {
  const local = localBinding(input.binding)
  enforceAuthorization(input, local)
  const controller = new AbortController()
  const signal = AbortSignal.any([
    input.signal,
    controller.signal,
    AbortSignal.timeout(5000),
  ])
  const serial = `${local.modelId}/${local.deviceId}`
  const clientCert = local.clientCertFile
    ? readKobraClientCertMaterial(local.clientCertFile)
    : undefined
  if (clientCert && !clientCert.ok) throw Error('offline')

  const connected = Promise.withResolvers<void>()
  let receive: ((payload: Buffer, topic: string) => void) | undefined
  const transport = createAnycubicControlTransport({
    host: local.host,
    port: local.port,
    serial,
    credentials: {
      username: local.username,
      password: z
        .string()
        .min(1)
        .max(2048)
        .parse(readPrivateJsonFile(local.passwordFile, { maxBytes: 4096 })),
    },
    ...(local.caFile ? { caPem: readFileSync(local.caFile, 'utf8') } : {}),
    ...(local.pinSha256 ? { pinSha256: local.pinSha256 } : {}),
    ...(clientCert?.ok
      ? {
          certPem: clientCert.cert.certificatePem,
          keyPem: clientCert.cert.keyPem,
        }
      : {}),
    limits: {
      maxFrameBytes: FRAME_LIMIT,
      connectTimeoutMs: 5000,
      maxInflight: 16,
      reconnectDelayMs: 1000,
      maxReconnects: 0,
    },
    signal,
    onConnection(state) {
      if (state === 'connected') connected.resolve()
      else controller.abort()
    },
    onReport(payload, topic) {
      receive?.(payload, topic)
    },
  })

  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(Error('offline'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()

  async function request(
    type: 'info' | 'file',
    action: 'query' | 'listLocal',
    data: null | ListRoot,
  ) {
    signal.throwIfAborted()
    const msgid = randomUUID()
    const reply = Promise.withResolvers<unknown>()
    receive = (payload, topic) => {
      if (topic !== `${MQTT_ROOT}/printer/public/${serial}/${type}/report`)
        return
      try {
        const parsed = Report.safeParse(
          parseBoundedJson(payload.toString('utf8'), {
            maxBytes: FRAME_LIMIT,
            maxDepth: 16,
            maxValues: 8192,
            maxStringChars: 16384,
          }),
        )
        if (!parsed.success) return
        const report = parsed.data
        if (
          report.type !== type ||
          report.msgid !== msgid ||
          report.action !== (type === 'info' ? 'report' : action)
        )
          return
        if (
          (report.code !== 0 && report.code !== 200) ||
          (report.state !== 'done' && report.state !== 'success')
        )
          reply.reject(Error('offline'))
        else reply.resolve(report.data)
      } catch {
        // Unsolicited or malformed reports cannot complete a request.
      }
    }
    try {
      const authorized = () => {
        signal.throwIfAborted()
        enforceAuthorization(input, local)
        return true
      }
      const sent = transport.publishFile(
        `${MQTT_ROOT}/slicer/printer/${serial}/${type}`,
        JSON.stringify({ type, action, timestamp: Date.now(), msgid, data }),
        authorized,
      )
      const [, result] = await Promise.race([
        aborted.promise,
        Promise.all([sent, reply.promise]),
      ])
      enforceAuthorization(input, local)
      return result
    } finally {
      receive = undefined
    }
  }

  try {
    await Promise.race([aborted.promise, connected.promise])
    const info = Info.parse(await request('info', 'query', null))
    if (info.version !== FIRMWARE) throw Error('unsupported')
    return await operation(info, request, local)
  } finally {
    signal.removeEventListener('abort', abort)
    controller.abort()
    await transport.close()
  }
}

export function listAnycubicFiles(input: FileRequest) {
  return withFileSession(input, async (_info, request) => {
    const { records } = z
      .object({ records: z.array(z.unknown()) })
      .parse(await request('file', 'listLocal', LIST_ROOT))
    const files = new Map<string, PrinterFile>()
    for (const value of records) {
      const record = FileRecord.safeParse(value)
      if (!record.success) continue
      const { filename, is_dir, size, timestamp } = record.data
      if (
        is_dir ||
        !validFileName(filename) ||
        !/\.gcode(?:\.3mf)?$/i.test(filename)
      )
        continue
      files.set(filename, {
        name: filename,
        size,
        // `PrinterFile.modified` is in seconds.
        modified: timestamp > 1e11 ? timestamp / 1000 : timestamp,
        ...(!isAnycubicStartFile(filename) ? { printUnsupported: true } : {}),
      })
    }
    return [...files.values()]
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 200)
  })
}

export async function uploadAnycubicFile(
  input: FileRequest & { filePath: string; name: string },
) {
  const local = localBinding(input.binding)
  enforceAuthorization(input, local)
  if (!supportsAnycubicUpload(input.name)) throw Error('unsupported')
  const content = await openAsBlob(input.filePath, {
    type: 'application/octet-stream',
  })
  if (!content.size || content.size > MAX_FILE_SIZE) throw Error('unsupported')

  const url = await withFileSession(input, async (info, _request, local) => {
    if (info.state !== 'free' || info.project) throw Error('busy')
    const host = local.host.includes(':') ? `[${local.host}]` : local.host
    const bound = new URL(
      `http://${host}:${local.uploadPort ?? 18910}/gcode_upload`,
    )
    const advertised = URL.parse(info.urls?.fileUploadurl ?? '')
    const token = advertised?.searchParams.get('s')
    if (
      !advertised ||
      advertised.origin !== bound.origin ||
      advertised.pathname !== bound.pathname ||
      advertised.username ||
      advertised.password ||
      advertised.hash ||
      !token ||
      token.length > 1024 ||
      advertised.searchParams.size !== 1
    )
      throw Error('unsupported')
    bound.searchParams.set('s', token)
    return bound
  })

  const form = new FormData()
  form.append('filename', input.name)
  form.append('gcode', content, input.name)
  const controller = new AbortController()
  const signal = AbortSignal.any([
    input.signal,
    controller.signal,
    AbortSignal.timeout(120000),
  ])
  enforceAuthorization(input, local)
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { 'X-File-Length': String(content.size) },
      body: form,
      signal,
    })
    if (response.status !== 200 || !response.body) throw Error()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 16384) throw Error()
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const result = UploadResponse.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    )
    if (!supportsAnycubicUpload(result.data.gcode)) throw Error()
  } catch {
    // The HTTP response or token must never escape through diagnostics.
    throw Error('offline')
  } finally {
    controller.abort()
  }
}

export interface AnycubicFileTransport {
  /** Connector-owned authenticated LAN MQTT session; resolves on acknowledgement. */
  publish(topic: string, payload: string, signal: AbortSignal): Promise<void>
}

export class AnycubicStartRefused extends Error {
  readonly refusal: 'unsupported-action' | 'invalid-command'
  constructor(refusal: AnycubicStartRefused['refusal'], message: string) {
    super(message)
    this.refusal = refusal
  }
}

export async function startAnycubicPrint(input: {
  transport: AnycubicFileTransport
  model: string
  deviceId: string
  filename: string
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  if (input.model !== ANYCUBIC_FILE_MODEL)
    throw new AnycubicStartRefused(
      'unsupported-action',
      'Unsupported Anycubic model',
    )
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId))
    throw new AnycubicStartRefused(
      'invalid-command',
      'Invalid Anycubic device ID',
    )
  if (!isAnycubicStartFile(input.filename))
    throw new AnycubicStartRefused(
      'invalid-command',
      'Invalid Anycubic filename',
    )
  await input.transport.publish(
    `anycubic/anycubicCloud/v1/slicer/printer/${input.model}/${input.deviceId}/print`,
    JSON.stringify({
      type: 'print',
      action: 'start',
      timestamp: Date.now(),
      msgid: randomUUID(),
      data: { taskid: '-1', filename: input.filename, filetype: 1 },
    }),
    input.signal,
  )
}
