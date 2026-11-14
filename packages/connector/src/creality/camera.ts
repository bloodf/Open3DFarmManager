// SPDX-License-Identifier: MIT
import { request } from 'node:http'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

export const MAX_CREality_JPEG_BYTES = 4 * 1024 * 1024

export function selectCrealityCamera(source: { host: string; port?: number }) {
  const { host, port = 8080 } = source
  const parts = host.split('.').map(Number)
  if (
    isIP(host) !== 4 ||
    !(
      parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    ) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error('Invalid Creality camera configuration')
  return { kind: 'mjpeg' as const, host, port }
}

export async function* readCrealityJpegs(
  chunks: AsyncIterable<Buffer>,
  boundary: string,
): AsyncGenerator<Buffer> {
  if (!/^[\x21-\x7e]{1,70}$/.test(boundary) || /["\\]/.test(boundary))
    throw Error('Invalid MJPEG boundary')
  const delimiter = Buffer.from('--' + boundary)
  const separator = Buffer.from('\r\n\r\n')
  let pending = Buffer.alloc(0)
  let state: 'boundary' | 'headers' | 'frame' = 'boundary'
  for await (const chunk of chunks) {
    pending = Buffer.concat([pending, chunk])
    while (true) {
      if (state === 'boundary') {
        if (pending.length < delimiter.length + 2) break
        if (!pending.subarray(0, delimiter.length).equals(delimiter))
          throw Error('Invalid MJPEG boundary')
        const suffix = pending
          .subarray(delimiter.length, delimiter.length + 2)
          .toString()
        if (suffix === '--') return
        if (suffix !== '\r\n') throw Error('Invalid MJPEG boundary')
        pending = pending.subarray(delimiter.length + 2)
        state = 'headers'
      } else if (state === 'headers') {
        const end = pending.indexOf(separator)
        if (end < 0) {
          if (pending.length > 8192) throw Error('Invalid MJPEG headers')
          break
        }
        if (
          end > 8192 ||
          !/^content-type:\s*image\/jpeg\s*$/im.test(
            pending.subarray(0, end).toString('latin1'),
          )
        )
          throw Error('Invalid MJPEG headers')
        pending = pending.subarray(end + 4)
        state = 'frame'
      } else {
        const end = pending.indexOf(
          Buffer.concat([Buffer.from('\r\n'), delimiter]),
        )
        if (end < 0) {
          if (pending.length > MAX_CREality_JPEG_BYTES + delimiter.length + 2)
            throw Error('MJPEG frame too large')
          break
        }
        if (
          end > MAX_CREality_JPEG_BYTES ||
          end < 4 ||
          pending.readUInt16BE(0) !== 0xffd8 ||
          pending.readUInt16BE(end - 2) !== 0xffd9
        )
          throw Error('Invalid MJPEG frame')
        yield Buffer.from(pending.subarray(0, end))
        pending = pending.subarray(end + 2)
        state = 'boundary'
      }
    }
  }
  throw Error('Truncated MJPEG stream')
}

export async function* streamCrealityJpegs(input: {
  host: string
  port?: number
  signal: AbortSignal
  reconnectDelayMs?: number
  maxReconnects?: number
}): AsyncGenerator<Buffer> {
  const source = selectCrealityCamera(input)
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
    throw Error('Invalid Creality camera reconnect limits')
  for (
    let attempt = 0;
    attempt <= retries && !input.signal.aborted;
    attempt++
  ) {
    const req = request({
      host: source.host,
      port: source.port,
      path: '/?action=stream',
      signal: input.signal,
      timeout: 5000,
    })
    req.on('timeout', () => req.destroy(Error('Camera timeout')))
    try {
      const response = await new Promise<import('node:http').IncomingMessage>(
        (resolve, reject) => {
          req.once('response', resolve)
          req.once('error', reject)
          req.end()
        },
      )
      if (response.statusCode !== 200) {
        response.destroy()
        throw Error('Invalid camera response')
      }
      const type = response.headers['content-type'] ?? ''
      const match =
        /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))\s*$/i.exec(
          type,
        )
      if (!match) {
        response.destroy()
        throw Error('Invalid camera content type')
      }
      try {
        yield* readCrealityJpegs(response, match[1] ?? match[2]!)
      } finally {
        response.destroy()
      }
    } catch {
      if (input.signal.aborted) return
    } finally {
      req.destroy()
    }
    if (attempt === retries) throw Error('Creality camera unavailable')
    try {
      await delay(Math.min(wait * 2 ** attempt, 30000), undefined, {
        signal: input.signal,
      })
    } catch {
      return
    }
  }
}
