/**
 * Stock LAN wire facts only; no vendor implementation copied.
 * Upload and K1 start path:
 * https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp
 * No listing request/response contract in these sources:
 * https://github.com/ChestnutLabs/printer-protocol-orchard/blob/main/protocols/creality.md
 * This module consumes an already staged Connector file; it creates no relay.
 */
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import WebSocket from 'ws'

export const CREALITY_MAX_FILE_BYTES = 512 * 1024 * 1024
export const CREALITY_FILE_CAPABILITIES = {
  upload: true,
  list: false,
  start: true,
} as const

function validateName(name: string) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,254}\.gcode$/i.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new Error('Invalid Creality G-code filename')
}

export async function listCrealityFiles(): Promise<never> {
  throw new Error('unsupported: Creality stock file listing is undocumented')
}

export async function uploadCrealityFile(input: {
  origin: string
  filePath: string
  name: string
  signal: AbortSignal
}): Promise<void> {
  validateName(input.name)
  const origin = new URL(input.origin)
  if (
    origin.protocol !== 'http:' ||
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
      const response = await fetch(
        new URL(`/upload/${encodeURIComponent(input.name)}`, origin),
        {
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          body: body as unknown as BodyInit,
          duplex: 'half',
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(30000)]),
          redirect: 'error',
        } as RequestInit & { duplex: 'half' },
      )
      await response.body?.cancel()
      if (response.status !== 200 && response.status !== 201)
        throw new Error(`Creality upload rejected: HTTP ${response.status}`)
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
