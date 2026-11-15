import { moonrakerSession, moonrakerAuthHeaders } from '../config/moonraker.ts'
import { z } from 'zod'
import { createMoonrakerSocket } from './socket.ts'
import { Reply, decodeMoonrakerFrame } from './frame.ts'
import { parseMoonrakerServerInfo } from './parse.ts'
import type { MoonrakerLimits } from '../config/moonraker.ts'
export {
  validateMoonrakerInput,
  type MoonrakerLimits,
} from '../config/moonraker.ts'

export type MoonrakerFailureReason =
  'offline' | 'stale' | 'not-ready' | 'invalid-response'

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
      headers: await (moonrakerSession(
        input.origin,
        input.limits,
      )?.getAuthHeaders() ?? moonrakerAuthHeaders(input.origin, input.limits)),
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
const completeObjects = {
  ...selectedObjects,
  extruder: ['temperature'],
  heater_bed: ['temperature'],
}

export function openMoonrakerClient(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
  discoverObjects?: boolean
  onStatus: (params: unknown) => void
  /** Opt-in display evidence; default telemetry transport remains unchanged. */
  onComplete?: (observation: MoonrakerCompleteObservation) => void
  onInvalidated?: () => void
}): {
  snapshot: Promise<unknown>
  closed: Promise<MoonrakerFailureReason>
  close: () => void
} {
  // Let the snapshot promise continuation install its baseline before a delta.
  let socket: ReturnType<typeof createMoonrakerSocket> | undefined
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  let queryTimeout: ReturnType<typeof setTimeout> | undefined
  let nextId = 1
  let pending: { id: number; started: number } | undefined
  let finished = false
  let subscribed = false
  let discovering = input.discoverObjects === true
  let objects: Record<string, string[]> = { ...selectedObjects }
  let queryObjects: Record<string, string[]> = { ...completeObjects }
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
    clearTimeout(discoveryTimer)
    clearTimeout(queryTimer)
    clearTimeout(queryTimeout)
    try {
      input.onInvalidated?.()
    } catch {
      /* Still destroy native transport. */
    }
    input.signal.removeEventListener('abort', abort)
    socket?.off('open', open)
    socket?.off('message', message)
    if (!subscribed) rejectSnapshot(new MoonrakerClientError(reason))
    // Keep the error listener until actual close: terminate during a handshake
    // emits an asynchronous error. Joining closed observes destruction, not intent.
    closedReason = reason
    if (socket) socket.terminate()
    else resolveClosed(reason)
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
    socket?.off('error', error)
    socket?.off('close', close)
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
    if (discovering) {
      discoveryTimer = setTimeout(
        () => {
          if (finished || !discovering) return
          discovering = false
          pending = { id: 1, started: performance.now() }
          socket!.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: nextId,
              method: 'printer.objects.subscribe',
              params: { objects },
            }),
          )
        },
        Math.min(50, input.limits.requestTimeoutMs / 2),
      )
    }
    // Optional RTC discovery precedes the subscription on the same connection.
    socket!.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: discovering ? Number.MAX_SAFE_INTEGER : 1,
        method: discovering
          ? 'printer.objects.list'
          : 'printer.objects.subscribe',
        ...(discovering ? {} : { params: { objects } }),
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
          if (socket!.bufferedAmount !== 0) throw Error('Outbound queue')
          socket!.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: nextId,
              method: 'printer.objects.query',
              params: { objects: queryObjects },
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
      const value = decodeMoonrakerFrame(
        data,
        isBinary,
        input.limits.maxMessageBytes,
      )
      const reply = Reply.safeParse(value)
      if (reply.success) {
        // Only the discovery request is outstanding until the base subscription.
        if (discovering && reply.data.id !== Number.MAX_SAFE_INTEGER) return
        // A discovery reply after the fallback cannot replace the baseline.
        if (
          input.discoverObjects &&
          !discovering &&
          reply.data.id === Number.MAX_SAFE_INTEGER &&
          typeof reply.data.result === 'object' &&
          reply.data.result !== null &&
          'objects' in reply.data.result
        )
          return
        if (
          !pending ||
          (reply.data.id !== pending.id &&
            !(discovering && reply.data.id === Number.MAX_SAFE_INTEGER)) ||
          !Object.hasOwn(reply.data, 'result')
        )
          throw new Error('Unexpected reply')
        if (discovering) {
          clearTimeout(discoveryTimer)
          const listed = z
            .object({ objects: z.array(z.string().min(1).max(128)).max(512) })
            .parse(reply.data.result)
          const optional = Object.fromEntries(
            listed.objects
              .filter(
                (name) =>
                  name === 'fan' ||
                  name.startsWith('fan_generic ') ||
                  name === 'output_pin caselight',
              )
              .map((name) => [
                name,
                [name === 'output_pin caselight' ? 'value' : 'speed'],
              ]),
          )
          objects = { ...selectedObjects, ...optional }
          queryObjects = { ...completeObjects, ...optional }
          discovering = false
          pending = { id: ++nextId, started: performance.now() }
          socket!.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: nextId,
              method: 'printer.objects.subscribe',
              params: { objects },
            }),
          )
          return
        }
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
  async function connect() {
    try {
      const session = moonrakerSession(input.origin, input.limits)
      const authenticatedUrl = session
        ? await session.getWebsocketUrl()
        : undefined
      if (finished) return
      socket = createMoonrakerSocket(input.origin, input.limits, {
        allowSynchronousEvents: false,
        ...(authenticatedUrl ? { authenticatedUrl } : {}),
      })
      socket.on('open', open)
      socket.on('message', message)
      socket.on('error', error)
      socket.on('close', close)
    } catch {
      finish('offline')
    }
  }
  void connect()
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  return { snapshot, closed, close: abort }
}
