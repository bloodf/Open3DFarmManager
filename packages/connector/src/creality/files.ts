/**
 * Stock LAN wire facts only; no vendor implementation copied.
 * Upload and K1 start path:
 * https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp
 * Upload to a printer that advertises the secure endpoint goes to
 * `https://<ip>:443/upload/<name>` (maker client):
 * https://github.com/CrealityOfficial/CrealityPrint/blob/6262848e302b8c0d593f2b341cd01310aa2f58a1/src/slic3r/GUI/print_manage/Device/Klipper4408Interface.cpp
 * Listing request, reply and stock storage paths:
 * https://github.com/Accessible3D-Edis/AccessSlice/blob/620e023e5425137c58353ffa6974c260b103d134/app/creality_lan.py#L17-L24
 * This module consumes an already staged Connector file; it creates no relay.
 */
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { z } from 'zod'
import type { PrinterFile } from '../../../farm-protocol/src/file-list.ts'
import {
  readCrealityPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { resolveCrealityEndpoint } from '../discovery/creality.ts'
import { crealityGcodeReference } from './gcode-path.ts'

export const CREALITY_MAX_FILE_BYTES = 512 * 1024 * 1024
export const CREALITY_FILE_CAPABILITIES = {
  upload: true,
  list: true,
  start: true,
} as const

function validateName(name: string) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,254}\.gcode$/i.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new Error('Invalid Creality G-code filename')
}

const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
})
const FileReport = z.object({ retGcodeFileInfo2: z.array(z.unknown()) })

function readFileReport(value: unknown) {
  const files = new Map<string, z.infer<typeof PrinterFile>>()
  for (const item of FileReport.parse(value).retGcodeFileInfo2) {
    const entry = FileEntry.safeParse(item)
    if (!entry.success) continue
    const { name, path, size } = entry.data
    const reference = crealityGcodeReference(name, path)
    if (!reference) continue
    const printRef = reference === name ? undefined : reference
    const previous = files.get(name)
    if (previous && previous.printRef !== printRef)
      throw Error('Ambiguous Creality filenames')
    files.set(name, {
      name,
      size,
      modified: 0,
      ...(printRef ? { printRef } : {}),
    })
  }
  return [...files.values()].slice(0, 200)
}

/** The first thing that went wrong while listing; later symptoms are ignored. */
export type CrealityFileListFailure =
  | 'unauthorized'
  | 'cancelled'
  | 'timeout'
  /** The advertised endpoint could not be resolved or verified. */
  | 'endpoint'
  | 'connect'
  | 'closed'
  | 'reply-invalid'
  | 'ambiguous-names'

export class CrealityFileListError extends Error {
  readonly reason: CrealityFileListFailure
  /** Whether the read request had left the Connector. No command ever does. */
  readonly requestSent: boolean
  constructor(
    reason: CrealityFileListFailure,
    requestSent: boolean,
    cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : `Creality file list failed: ${reason}`,
      { cause },
    )
    this.name = 'CrealityFileListError'
    this.reason = reason
    this.requestSent = requestSent
  }
}

export async function listCrealityFiles(input: {
  binding: PrinterBinding
  signal: AbortSignal
  authorized(): boolean
}): Promise<z.infer<typeof PrinterFile>[]> {
  const local = readCrealityPrinterBinding(input.binding)
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(8000)])
  let requestSent = false
  const stop = (reason: CrealityFileListFailure, cause: unknown) =>
    cause instanceof CrealityFileListError
      ? cause
      : new CrealityFileListError(reason, requestSent, cause)
  const aborted = () => (input.signal.aborted ? 'cancelled' : 'timeout')
  const check = () => {
    if (signal.aborted) throw stop(aborted(), signal.reason)
    if (
      !local ||
      readCrealityPrinterBinding(input.binding) !== local ||
      !input.authorized()
    )
      throw stop('unauthorized', Error('unauthorized'))
    return local
  }
  const target = check()
  let endpoint: Awaited<ReturnType<typeof resolveCrealityEndpoint>>
  try {
    endpoint = await resolveCrealityEndpoint(target)
  } catch (error) {
    throw stop(signal.aborted ? aborted() : 'endpoint', error)
  }
  const { host } = check()
  const socketHost = host.includes(':') ? `[${host}]` : host
  const socket = new WebSocket(
    `${endpoint.secure ? 'wss' : 'ws'}://${socketHost}:${endpoint.port}/`,
    {
      ...(endpoint.ca ? { ca: endpoint.ca } : {}),
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 5000,
    },
  )
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => finish(stop(aborted(), signal.reason))
      function finish(error: CrealityFileListError) {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
      const lost = (error: unknown) =>
        finish(stop(requestSent ? 'closed' : 'connect', error))
      signal.addEventListener('abort', abort, { once: true })
      socket.once('error', lost)
      socket.once('close', () => lost(Error('Creality connection closed')))
      socket.once('open', () => {
        try {
          check()
          socket.send(
            JSON.stringify({ method: 'get', params: { reqGcodeFile: 1 } }),
          )
          requestSent = true
        } catch (error) {
          finish(stop('connect', error))
        }
      })
      socket.on('message', (raw, binary) => {
        if (binary) return
        try {
          check()
          let value: unknown
          try {
            value = JSON.parse(raw.toString())
          } catch {
            return
          }
          if (!value || typeof value !== 'object') return
          if ('ModeCode' in value && value.ModeCode === 'heart_beat') {
            socket.send('ok')
            return
          }
          if (!('retGcodeFileInfo2' in value)) return
          const files = readFileReport(value)
          signal.removeEventListener('abort', abort)
          resolve(files)
        } catch (error) {
          finish(
            stop(
              error instanceof Error &&
                error.message === 'Ambiguous Creality filenames'
                ? 'ambiguous-names'
                : 'reply-invalid',
              error,
            ),
          )
        }
      })
    })
  } finally {
    socket.terminate()
  }
}

/**
 * Where a staged file goes. A secure printer gets it over verified HTTPS; an
 * endpoint that cannot be verified refuses instead of falling back to HTTP.
 */
export async function resolveCrealityUploadOrigin(target: {
  origin: string
  endpoint?: Parameters<typeof resolveCrealityEndpoint>[0] | undefined
}): Promise<{ origin: string; ca?: string }> {
  if (!target.endpoint) return { origin: target.origin }
  const endpoint = await resolveCrealityEndpoint(target.endpoint)
  if (!endpoint.secure) return { origin: target.origin }
  const host = endpoint.host.includes(':')
    ? `[${endpoint.host}]`
    : endpoint.host
  return {
    origin: `https://${host}:${endpoint.httpsPort}`,
    ...(endpoint.ca ? { ca: endpoint.ca } : {}),
  }
}

/** `fetch` takes no per-request CA, so the secure upload uses node:https. */
function postSecure(input: {
  url: URL
  contentType: string
  body: Readable
  ca: string | undefined
  signal: AbortSignal
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      input.url,
      {
        method: 'POST',
        headers: { 'content-type': input.contentType },
        signal: input.signal,
        ...(input.ca ? { ca: input.ca } : {}),
      },
      (response) => {
        response.destroy()
        resolve(response.statusCode ?? 0)
      },
    )
    request.on('error', reject)
    input.body.once('error', (error) => request.destroy(error))
    input.body.pipe(request)
  })
}

export async function uploadCrealityFile(input: {
  origin: string
  /** Trust root of a secure printer; only with an `https:` origin. */
  ca?: string | undefined
  filePath: string
  name: string
  signal: AbortSignal
}): Promise<void> {
  validateName(input.name)
  const origin = new URL(input.origin)
  if (
    (origin.protocol !== 'https:' &&
      (origin.protocol !== 'http:' || input.ca !== undefined)) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Invalid Creality HTTP origin')
  input.signal.throwIfAborted()
  const handle = await open(input.filePath, 'r')
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > CREALITY_MAX_FILE_BYTES
    )
      throw new Error('Invalid Creality staged file size')
    const boundary = `----connector-${randomUUID()}`
    const file = handle.createReadStream({ autoClose: false })
    async function* parts() {
      yield `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      let bytes = 0
      for await (const chunk of file) {
        bytes += chunk.length
        if (bytes > stat.size) throw new Error('Staged file grew during upload')
        yield chunk
      }
      if (bytes !== stat.size)
        throw new Error('Staged file changed during upload')
      yield `\r\n--${boundary}--\r\n`
    }
    const body = Readable.from(parts())
    try {
      const url = new URL(`/upload/${encodeURIComponent(input.name)}`, origin)
      const contentType = `multipart/form-data; boundary=${boundary}`
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30000)])
      let status: number
      if (url.protocol === 'https:')
        status = await postSecure({
          url,
          contentType,
          body,
          ca: input.ca,
          signal,
        })
      else {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: body as unknown as BodyInit,
          duplex: 'half',
          signal,
          redirect: 'error',
        } as RequestInit & { duplex: 'half' })
        await response.body?.cancel()
        status = response.status
      }
      if (status !== 200 && status !== 201)
        throw new Error(`Creality upload rejected: HTTP ${status}`)
    } finally {
      body.destroy()
      file.destroy()
    }
  } finally {
    await handle.close()
  }
}

/** Resolves when sent, never claims that the printer accepted or started it. */
export async function startCrealityPrint(input: {
  host: string
  name: string
  signal: AbortSignal
  port?: number
}): Promise<{ status: 'sent' }> {
  validateName(input.name)
  if (
    !/^[A-Za-z0-9.-]+$/.test(input.host) ||
    (input.port !== undefined &&
      (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535))
  )
    throw new Error('Invalid Creality WebSocket endpoint')
  input.signal.throwIfAborted()
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30000)])
  const socket = new WebSocket(`ws://${input.host}:${input.port ?? 9999}/`, {
    maxPayload: 65536,
    followRedirects: false,
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      const finish = (error?: Error) => {
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      socket.once('error', finish)
      socket.once('close', () =>
        finish(new Error('Creality connection closed')),
      )
      socket.once('open', () => {
        if (signal.aborted) return abort()
        socket.send(
          JSON.stringify({
            method: 'set',
            params: {
              opGcodeFile: `printprt:/usr/data/printer_data/gcodes/${input.name}`,
            },
          }),
          finish,
        )
      })
    })
    return { status: 'sent' }
  } finally {
    socket.terminate()
  }
}
