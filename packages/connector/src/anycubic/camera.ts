// SPDX-License-Identifier: MIT
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { isKobraXFlvPath, isKobraXFlvPort } from '../kobra-x/camera.ts'
import { readCrealityJpegs, selectCrealityCamera } from '../creality/camera.ts'

export type AnycubicCameraSource = Readonly<
  | {
      kind: 'rinkhals'
      host: string
      port?: number
      /** Optional HTTP Basic credentials from trusted local configuration. */
      auth?: { username: string; password: string }
    }
  | {
      kind: 'kobra-x-flv'
      host: string
      port: number
      path: string
    }
  | {
      kind: 'stock'
      host: string
      port?: number
      /** Local control adapter sends video/startCapture and returns its stream URL.
       * Starting capture also turns on the printer illumination. */
      startCapture(signal: AbortSignal): Promise<string>
      stopCapture(): Promise<void>
    }
>

export function selectAnycubicCamera(source: AnycubicCameraSource) {
  const port = source.port ?? (source.kind === 'rinkhals' ? 8080 : 18088)
  try {
    selectCrealityCamera({ host: source.host, port })
    if (source.kind === 'rinkhals') {
      if (
        source.auth &&
        (!/^[\x20-\x7e]{1,128}$/.test(source.auth.username) ||
          source.auth.username.includes(':') ||
          !/^[\x20-\x7e]{1,128}$/.test(source.auth.password))
      )
        throw Error()
      return { kind: 'mjpeg' as const, host: source.host, port }
    }
    if (source.kind === 'kobra-x-flv') {
      if (!isKobraXFlvPath(source.path) || !isKobraXFlvPort(source.host, port))
        throw Error()
      return { kind: 'flv' as const, host: source.host, port }
    }
    if (
      source.kind !== 'stock' ||
      typeof source.startCapture !== 'function' ||
      typeof source.stopCapture !== 'function'
    )
      throw Error()
    return { kind: 'stock' as const, host: source.host, port }
  } catch {
    throw Error('Invalid Anycubic camera configuration')
  }
}

/** Session URLs never leave the local media source. Reject alternate destinations. */
export function selectAnycubicStream(
  source: AnycubicCameraSource,
  value: string,
) {
  const selected = selectAnycubicCamera(source)
  try {
    if (value.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(value)) throw Error()
    const url = new URL(value)
    if (
      source.kind !== 'stock' ||
      !['http:', 'rtsp:'].includes(url.protocol) ||
      url.hostname !== selected.host ||
      Number(url.port || (url.protocol === 'http:' ? 80 : 554)) !==
        selected.port ||
      url.hash ||
      url.search ||
      !/^\/[A-Za-z0-9_~.!$&()+,;=:@%/-]{1,1024}$/.test(url.pathname)
    )
      throw Error()
    return url
  } catch {
    throw Error('Invalid Anycubic camera stream')
  }
}

export async function* streamAnycubicJpegs(input: {
  source: Extract<AnycubicCameraSource, { kind: 'rinkhals' }>
  signal: AbortSignal
  reconnectDelayMs?: number
  maxReconnects?: number
}): AsyncGenerator<Buffer> {
  const source = {
    ...input.source,
    ...(input.source.auth ? { auth: { ...input.source.auth } } : {}),
  }
  const selected = selectAnycubicCamera(source)
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
    throw Error('Invalid Anycubic camera reconnect limits')
  let attempt = 0
  while (attempt <= retries && !input.signal.aborted) {
    const req = request({
      host: selected.host,
      port: selected.port,
      path: '/?action=stream',
      ...(source.auth
        ? { auth: source.auth.username + ':' + source.auth.password }
        : {}),
      signal: input.signal,
      timeout: 5000,
    })
    req.on('timeout', () => req.destroy(Error('Camera timeout')))
    let healthy = false
    try {
      const response = await new Promise<import('node:http').IncomingMessage>(
        (resolve, reject) => {
          req.once('response', resolve)
          req.once('error', reject)
          req.end()
        },
      )
      try {
        if (response.statusCode !== 200) throw Error()
        const match =
          /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))\s*$/i.exec(
            response.headers['content-type'] ?? '',
          )
        const boundary = match?.[1] ?? match?.[2]
        if (!boundary) throw Error()
        yield* readCrealityJpegs(response, boundary)
        healthy = true
      } finally {
        response.destroy()
      }
    } catch {
      if (input.signal.aborted) return
    } finally {
      req.destroy()
    }
    if (healthy) {
      // A completed stream replenishes the reconnect budget so a long-lived
      // camera can recover from later drops (#616).
      attempt = 0
    } else if (attempt === retries) {
      throw Error('Anycubic camera unavailable')
    }
    try {
      await delay(Math.min(wait * 2 ** attempt, 30000), undefined, {
        signal: input.signal,
      })
    } catch {
      return
    }
    if (!healthy) attempt++
  }
}
