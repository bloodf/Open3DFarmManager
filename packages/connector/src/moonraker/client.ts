import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { parseMoonrakerServerInfo } from './parse.ts'

export type MoonrakerLimits = Readonly<{
  maxMessageBytes: number
  connectTimeoutMs: number
  requestTimeoutMs: number
  staleAfterMs: number
  reconnectMinMs: number
  reconnectMaxMs: number
}>

export type MoonrakerFailureReason =
  | 'offline'
  | 'stale'
  | 'not-ready'
  | 'invalid-response'

export class MoonrakerClientError extends Error {
  readonly reason: MoonrakerFailureReason
  constructor(reason: MoonrakerFailureReason) {
    super(`Moonraker connection rejected: ${reason}`)
    this.name = 'MoonrakerClientError'
    this.reason = reason
  }
}

const duration = z.number().int().min(1).max(2_147_483_647)
const Limits = z
  .strictObject({
    maxMessageBytes: z
      .number()
      .int()
      .min(256)
      .max(256 * 1024),
    connectTimeoutMs: duration,
    requestTimeoutMs: duration,
    staleAfterMs: duration,
    reconnectMinMs: duration,
    reconnectMaxMs: duration,
  })
  .refine((value) => value.reconnectMinMs <= value.reconnectMaxMs)

export function validateMoonrakerInput(input: {
  assignment: { printerKey: string; origin: string }
  allowedOrigins: readonly string[]
  limits: MoonrakerLimits
}): { printerKey: string; origin: string; limits: MoonrakerLimits } {
  const printerKey = z
    .string()
    .min(1)
    .max(128)
    .refine((key) => !/[\u0000\uD800-\uDFFF]/u.test(key))
    .parse(input.assignment.printerKey)
  const limits = Limits.parse(input.limits)
  function originOnly(value: string): string {
    if (
      !/^https?:\/\/[^/?#]+\/?$/i.test(value) ||
      /[\u0000-\u0020\u007F]/u.test(value) ||
      value.includes('@') ||
      value.includes('\\') ||
      value.trim() !== value
    )
      throw new Error('Invalid local Moonraker origin')
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid local Moonraker origin')
    return url.origin
  }
  const origin = originOnly(input.assignment.origin)
  if (!input.allowedOrigins.map(originOnly).includes(origin))
    throw new Error('Moonraker origin is not allowlisted')
  return { printerKey, origin, limits }
}

export async function readMoonrakerReady(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
}): Promise<void> {
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const timer = setTimeout(
    () => controller.abort(),
    input.limits.requestTimeoutMs,
  )
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(`${input.origin}/server/info`, {
      signal,
      redirect: 'error',
      credentials: 'omit',
    })
    if (!response.ok || !response.body)
      throw new MoonrakerClientError('offline')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > input.limits.maxMessageBytes)
        throw new MoonrakerClientError('invalid-response')
      chunks.push(item.value)
    }
    let ready: boolean
    try {
      ready = parseMoonrakerServerInfo(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ).ready
    } catch {
      throw new MoonrakerClientError('invalid-response')
    }
    if (!ready) throw new MoonrakerClientError('not-ready')
  } catch (error) {
    if (error instanceof MoonrakerClientError) throw error
    throw new MoonrakerClientError('offline')
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

const Reply = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.literal(1),
  result: z.unknown(),
})
const Notification = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().max(128),
  params: z.array(z.unknown()).max(4).optional(),
})

// Native WebSocket buffers messages before dispatch. This cap bounds parsing,
// not native receive allocation. The API has no receive backpressure or maxPayload.
export function openMoonrakerClient(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
  onStatus: (params: unknown) => void
}): {
  snapshot: Promise<unknown>
  closed: Promise<MoonrakerFailureReason>
  close: () => void
} {
  const url = new URL('/websocket', input.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  let finished = false
  let subscribed = false
  let resolveSnapshot: (value: unknown) => void = () => {}
  let rejectSnapshot: (reason: Error) => void = () => {}
  let resolveClosed: (reason: MoonrakerFailureReason) => void = () => {}
  const snapshot = new Promise<unknown>((resolve, reject) => {
    resolveSnapshot = resolve
    rejectSnapshot = reject
  })
  const closed = new Promise<MoonrakerFailureReason>((resolve) => {
    resolveClosed = resolve
  })
  let timer = setTimeout(() => finish('offline'), input.limits.connectTimeoutMs)
  function finish(reason: MoonrakerFailureReason) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    input.signal.removeEventListener('abort', abort)
    socket.removeEventListener('open', open)
    socket.removeEventListener('message', message)
    socket.removeEventListener('error', error)
    socket.removeEventListener('close', error)
    if (!subscribed) rejectSnapshot(new MoonrakerClientError(reason))
    resolveClosed(reason)
    socket.close()
  }
  function abort() {
    finish('offline')
  }
  function error() {
    finish('offline')
  }
  function open() {
    if (finished) return
    clearTimeout(timer)
    timer = setTimeout(() => finish('offline'), input.limits.requestTimeoutMs)
    // A new socket has exactly one request and one fixed, bounded request ID.
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'printer.objects.subscribe',
        params: {
          objects: {
            webhooks: ['state'],
            print_stats: ['state'],
            virtual_sdcard: ['progress'],
          },
        },
      }),
    )
  }
  function message(event: MessageEvent) {
    if (finished) return
    try {
      if (
        typeof event.data !== 'string' ||
        Buffer.byteLength(event.data, 'utf8') > input.limits.maxMessageBytes
      )
        throw new Error('Invalid frame')
      const value = parseBoundedJson(event.data, {
        maxBytes: input.limits.maxMessageBytes,
        maxDepth: 16,
        maxValues: 8192,
        maxStringChars: 16384,
      })
      const reply = Reply.safeParse(value)
      if (reply.success) {
        if (subscribed || !Object.hasOwn(reply.data, 'result'))
          throw new Error('Unexpected reply')
        subscribed = true
        clearTimeout(timer)
        resolveSnapshot(reply.data.result)
        return
      }
      const notification = Notification.parse(value)
      if (notification.method === 'notify_status_update') {
        if (!subscribed) throw new Error('Status before baseline')
        input.onStatus(notification.params)
      } else if (
        [
          'notify_klippy_disconnected',
          'notify_klippy_shutdown',
          'notify_klippy_ready',
        ].includes(notification.method)
      ) {
        finish('not-ready')
      }
    } catch {
      finish('invalid-response')
    }
  }
  socket.addEventListener('open', open)
  socket.addEventListener('message', message)
  socket.addEventListener('error', error)
  socket.addEventListener('close', error)
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  return { snapshot, closed, close: abort }
}
