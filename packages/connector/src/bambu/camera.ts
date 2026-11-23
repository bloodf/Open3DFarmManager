// SPDX-License-Identifier: MIT
import { connect } from 'node:tls'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export const MAX_BAMBU_JPEG_BYTES = 4 * 1024 * 1024
export type BambuCameraSource = Readonly<{
  model: string
  host: string
  accessCode: string
  /** Alternate port on IPv4 loopback for local camera simulators. */
  port?: number
  /** A local CA is required for RTSPS. JPEG also supports an exact certificate pin. */
  caFile?: string
  pinSha256?: string
}>

export function selectBambuCamera(source: BambuCameraSource) {
  const { model, host, accessCode } = source
  const parts = host.split('.').map(Number)
  if (
    isIP(host) !== 4 ||
    !(
      parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    ) ||
    (source.port !== undefined &&
      (parts[0] !== 127 ||
        !Number.isInteger(source.port) ||
        source.port < 1 ||
        source.port > 65535)) ||
    !/^[\x21-\x7e]{1,32}$/.test(accessCode) ||
    (source.pinSha256 !== undefined && !/^[a-f\d]{64}$/i.test(source.pinSha256))
  )
    throw Error('Invalid Bambu camera configuration')
  const normalized = model.toUpperCase().replace(/[ _-]/g, '')
  if (/^(A1(MINI)?|P1[PS]?)$/.test(normalized))
    return { kind: 'jpeg' as const, port: source.port ?? 6000 }
  if (/^(X1[CE]?|X1CARBON|H2[DSC]?|P2S?)$/.test(normalized))
    return { kind: 'rtsps' as const, port: source.port ?? 322 }
  throw Error('Unsupported Bambu camera model')
}

export function bambuCameraAuth(accessCode: string): Buffer {
  if (!/^[\x21-\x7e]{1,32}$/.test(accessCode))
    throw Error('Invalid Bambu camera credentials')
  const packet = Buffer.alloc(80)
  packet.writeUInt32LE(0x40, 0)
  packet.writeUInt32LE(0x3000, 4)
  packet.write('bblp', 16, 'ascii')
  packet.write(accessCode, 48, 'ascii')
  return packet
}

/** Pull-based parsing bounds retained memory even when the peer streams continuously. */
export async function* readBambuJpegs(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  let header = Buffer.alloc(16)
  let frame: Buffer | undefined
  let offset = 0
  for await (const chunk of chunks) {
    let position = 0
    while (position < chunk.length) {
      const target = frame ?? header
      const count = Math.min(target.length - offset, chunk.length - position)
      chunk.copy(target, offset, position, position + count)
      position += count
      offset += count
      if (offset !== target.length) continue
      offset = 0
      if (!frame) {
        const size = header.readUInt32LE(0)
        if (size < 4 || size > MAX_BAMBU_JPEG_BYTES)
          throw Error('Invalid Bambu camera frame size')
        frame = Buffer.alloc(size)
      } else {
        if (
          frame.readUInt16BE(0) !== 0xffd8 ||
          frame.readUInt16BE(frame.length - 2) !== 0xffd9
        )
          throw Error('Invalid Bambu camera JPEG')
        yield frame
        frame = undefined
      }
    }
  }
  if (frame || offset) throw Error('Truncated Bambu camera frame')
}

export async function* streamBambuJpegs(input: {
  host: string
  accessCode: string
  caPem?: Buffer
  pinSha256?: string
  signal: AbortSignal
  /** Trusted local fixture/endpoint override; production defaults to 6000. */
  port?: number
  reconnectDelayMs?: number
  maxReconnects?: number
}): AsyncGenerator<Buffer> {
  const auth = bambuCameraAuth(input.accessCode)
  if (!input.caPem && !/^[a-f\d]{64}$/i.test(input.pinSha256 ?? ''))
    throw Error('Bambu camera TLS trust required')
  const retries = input.maxReconnects ?? 3
  const wait = input.reconnectDelayMs ?? 250
  if (
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 10 ||
    !Number.isFinite(wait) ||
    wait < 1 ||
    wait > 30000
  )
    throw Error('Invalid Bambu camera reconnect limits')
  for (
    let attempt = 0;
    attempt <= retries && !input.signal.aborted;
    attempt++
  ) {
    const socket = connect({
      host: input.host,
      port: input.port ?? 6000,
      ...(input.caPem ? { ca: input.caPem } : {}),
      rejectUnauthorized: Boolean(input.caPem) || !input.pinSha256,
    })
    const abort = () => socket.destroy()
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
    socket.setTimeout(5000, () => socket.destroy(Error('Bambu camera timeout')))
    try {
      await once(socket, 'secureConnect', { signal: input.signal })
      if (
        input.pinSha256 &&
        createHash('sha256')
          .update(socket.getPeerCertificate().raw)
          .digest('hex') !== input.pinSha256.toLowerCase()
      )
        throw Error('Bambu camera TLS trust failed')
      if (input.signal.aborted) return
      socket.write(auth)
      yield* readBambuJpegs(socket)
    } catch {
      if (input.signal.aborted) return
      if (attempt === retries) throw Error('Bambu camera unavailable')
    } finally {
      input.signal.removeEventListener('abort', abort)
      socket.destroy()
    }
    if (attempt === retries) throw Error('Bambu camera unavailable')
    try {
      await delay(wait, undefined, { signal: input.signal })
    } catch {
      return
    }
  }
}
