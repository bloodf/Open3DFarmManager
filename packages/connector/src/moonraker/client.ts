import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { parseMoonrakerServerInfo } from './parse.ts'
import type { MoonrakerLimits } from '../config/moonraker.ts'
export {
  validateMoonrakerInput,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

// Set before module evaluation. Do not statically import ws or enable addons.
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const { default: WebSocket } = await import('ws')

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
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  result: z.unknown(),
})
const Notification = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().max(128),
  params: z.array(z.unknown()).max(4).optional(),
})

export type MoonrakerCompleteObservation = Readonly<{
  result: unknown
  requestStartedAtMonoMs: number
  receivedAtMonoMs: number
}>
const selectedObjects = {
  webhooks: ['state'],
  print_stats: ['state'],
  virtual_sdcard: ['progress'],
}

// The ws receiver enforces payload/fragment/chunk bounds before message dispatch.
// Compression, redirects and optional native addons are disabled.
export function openMoonrakerClient(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
  onStatus: (params: unknown) => void
  /** Opt-in display evidence; default telemetry transport remains unchanged. */
  onComplete?: (observation: MoonrakerCompleteObservation) => void
  onInvalidated?: () => void
}): {
  snapshot: Promise<unknown>
  closed: Promise<MoonrakerFailureReason>
  close: () => void
} {
  const url = new URL('/websocket', input.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url, {
    maxPayload: input.limits.maxMessageBytes,
    maxFragments: 128,
    maxBufferedChunks: 128,
    // Let the snapshot promise continuation install its baseline before a delta.
    allowSynchronousEvents: false,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: input.limits.connectTimeoutMs,
    skipUTF8Validation: false,
  })
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  let queryTimeout: ReturnType<typeof setTimeout> | undefined
  let nextId = 1
  let pending: { id: number; started: number } | undefined
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
    clearTimeout(queryTimer)
    clearTimeout(queryTimeout)
    try {
      input.onInvalidated?.()
    } catch {
      /* Still destroy native transport. */
    }
    input.signal.removeEventListener('abort', abort)
    socket.off('open', open)
    socket.off('message', message)
    if (!subscribed) rejectSnapshot(new MoonrakerClientError(reason))
    // Keep the error listener until actual close: terminate during a handshake
    // emits an asynchronous error. Joining closed observes destruction, not intent.
    closedReason = reason
    socket.terminate()
  }
  function abort() {
    finish('offline')
  }
  let closedReason: MoonrakerFailureReason = 'offline'
  function error(cause: Error) {
    const protocolError =
      'code' in cause &&
      typeof cause.code === 'string' &&
      cause.code.startsWith('WS_ERR_')
    finish(protocolError ? 'invalid-response' : 'offline')
  }
  function close() {
    finish('offline')
    socket.off('error', error)
    socket.off('close', close)
    resolveClosed(closedReason)
  }
  function open() {
    if (finished) return
    clearTimeout(timer)
    timer = setTimeout(
      () => finish('offline'),
      input.onComplete
        ? Math.min(1000, input.limits.requestTimeoutMs)
        : input.limits.requestTimeoutMs,
    )
    pending = { id: 1, started: performance.now() }
    // Subscribe remains the only request unless raw display evidence is enabled.
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'printer.objects.subscribe',
        params: {
          objects: selectedObjects,
        },
      }),
    )
  }
  function scheduleQuery() {
    if (!input.onComplete || finished) return
    queryTimer = setTimeout(
      () => {
        if (finished || pending || nextId >= Number.MAX_SAFE_INTEGER) {
          finish('invalid-response')
          return
        }
        const started = performance.now()
        pending = { id: ++nextId, started }
        queryTimeout = setTimeout(
          () => finish('stale'),
          Math.min(1000, input.limits.requestTimeoutMs),
        )
        try {
          if (socket.bufferedAmount !== 0) throw Error('Outbound queue')
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: nextId,
              method: 'printer.objects.query',
              params: { objects: selectedObjects },
            }),
          )
        } catch {
          finish('offline')
        }
      },
      Math.max(0, 1000 - (performance.now() - lastRequestStarted)),
    )
  }
  let lastRequestStarted = 0
  function message(data: import('ws').RawData, isBinary: boolean) {
    if (finished) return
    try {
      if (
        isBinary ||
        !Buffer.isBuffer(data) ||
        data.byteLength > input.limits.maxMessageBytes
      )
        throw new Error('Invalid frame')
      const value = parseBoundedJson(data.toString('utf8'), {
        maxBytes: input.limits.maxMessageBytes,
        maxDepth: 16,
        maxValues: 8192,
        maxStringChars: 16384,
      })
      const reply = Reply.safeParse(value)
      if (reply.success) {
        if (
          !pending ||
          reply.data.id !== pending.id ||
          !Object.hasOwn(reply.data, 'result')
        )
          throw new Error('Unexpected reply')
        const received = performance.now(),
          started = pending.started
        if (
          received < started ||
          (input.onComplete &&
            received - started >= Math.min(1000, input.limits.requestTimeoutMs))
        )
          throw Error('Late observation')
        pending = undefined
        lastRequestStarted = started
        clearTimeout(queryTimeout)
        input.onComplete?.(
          Object.freeze({
            result: reply.data.result,
            requestStartedAtMonoMs: started,
            receivedAtMonoMs: received,
          }),
        )
        if (!subscribed) {
          subscribed = true
          clearTimeout(timer)
          resolveSnapshot(reply.data.result)
        }
        scheduleQuery()
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
  socket.on('open', open)
  socket.on('message', message)
  socket.on('error', error)
  socket.on('close', close)
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  return { snapshot, closed, close: abort }
}
