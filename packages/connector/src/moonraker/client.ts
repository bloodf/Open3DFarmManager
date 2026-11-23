import { isChamberTemperatureObject } from './temperature-observation.ts'
import { moonrakerSession, moonrakerAuthHeaders } from '../config/moonraker.ts'
import { z } from 'zod'
import { createMoonrakerSocket } from './socket.ts'
import { Reply, decodeMoonrakerFrame } from './frame.ts'
import { parseMoonrakerServerInfo } from './parse.ts'
import {
  extruderIndex,
  parseIdentifyResult,
  selectToolObjects,
} from './discovery-parse.ts'
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

// Status objects have open fields, including explicitly nullable values.
const ObjectStatus = z.record(z.string(), z.record(z.string(), z.unknown()))
const StatusUpdate = z.tuple([ObjectStatus, z.number().nonnegative()])
const StatusResult = z.object({
  status: ObjectStatus,
  eventtime: z.number().nonnegative(),
})

const Notification = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().max(128),
  params: z.array(z.unknown()).max(4).optional(),
})

export type MoonrakerCompleteObservation = Readonly<{
  result: unknown
  /** This request selected toolhead.extruder alongside the nozzle readings. */
  activeToolQuery: boolean
  requestStartedAtMonoMs: number
  receivedAtMonoMs: number
}>
/** Reserved request id for the identify call that precedes every subscription. */
const IDENTIFY_ID = Number.MAX_SAFE_INTEGER - 1
const DEFAULT_CLIENT = {
  name: 'Open3DFarmManager',
  version: '1',
  url: 'https://open3dfarmmanager.local',
}
const selectedObjects = {
  webhooks: ['state'],
  print_stats: ['state'],
  virtual_sdcard: ['progress'],
}
const temperatureObjects = {
  extruder: ['temperature'],
  heater_bed: ['temperature'],
}
const completeObjects = { ...selectedObjects, ...temperatureObjects }
/** Finished-job fields; Moonraker reports only the fields a request names. */
const jobObjects = {
  ...selectedObjects,
  print_stats: [
    'state',
    'filename',
    'print_duration',
    'total_duration',
    'filament_used',
    'info',
  ],
}

function parseIdentifyResultSafe(result: unknown): boolean {
  try {
    parseIdentifyResult(result)
    return true
  } catch {
    return false
  }
}

export function openMoonrakerClient(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
  discoverObjects?: boolean
  /** Also subscribe to the print_stats fields a finished-job summary needs. */
  jobFields?: boolean
  /** Model-specific read-only objects added to every subscription and query. */
  extraObjects?: Readonly<Record<string, readonly string[]>>
  /** Connector identity registered with Moonraker on every connection. */
  client?: { name: string; version: string; url: string }
  onStatus: (params: unknown) => void
  /** Opt-in display evidence; default telemetry transport remains unchanged. */
  onComplete?: (observation: MoonrakerCompleteObservation) => void
  onRequestSuccess?: (startedAtMonoMs: number, receivedAtMonoMs: number) => void
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
  let pending:
    { id: number; started: number; activeToolQuery: boolean } | undefined
  let finished = false
  let subscribed = false
  let identified = false
  let discovering = input.discoverObjects === true
  const extraObjects = Object.fromEntries(
    Object.entries(input.extraObjects ?? {}).map(([name, fields]) => [
      name,
      [...fields],
    ]),
  )
  const baseObjects = {
    ...(input.jobFields ? jobObjects : selectedObjects),
    ...extraObjects,
  }
  const baseQueryObjects = {
    ...(input.jobFields
      ? { ...jobObjects, ...temperatureObjects }
      : completeObjects),
    ...extraObjects,
  }
  let objects: Record<string, string[]> = { ...baseObjects }
  let queryObjects: Record<string, string[]> = { ...baseQueryObjects }
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
      () => finish(earlyUpdates.length ? 'invalid-response' : 'offline'),
      input.onComplete
        ? Math.min(1000, input.limits.requestTimeoutMs)
        : input.limits.requestTimeoutMs,
    )
    // Moonraker must attribute this connection before any subscription.
    const client = input.client ?? DEFAULT_CLIENT
    socket!.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: IDENTIFY_ID,
        method: 'server.connection.identify',
        params: {
          client_name: client.name,
          version: client.version,
          type: 'agent',
          url: client.url,
        },
      }),
    )
  }
  function sendStatusRequest(
    method: 'printer.objects.subscribe' | 'printer.objects.query',
    requestObjects: Record<string, string[]>,
  ) {
    pending = {
      id: nextId,
      started: performance.now(),
      activeToolQuery:
        requestObjects.toolhead?.includes('extruder') === true &&
        Object.entries(requestObjects).some(
          ([name, fields]) =>
            extruderIndex(name) !== undefined && fields.includes('temperature'),
        ),
    }
    socket!.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: nextId,
        method,
        params: { objects: requestObjects },
      }),
    )
  }
  function begin() {
    if (!discovering) {
      sendStatusRequest('printer.objects.subscribe', objects)
      return
    }
    discoveryTimer = setTimeout(
      () => {
        if (finished || !discovering) return
        discovering = false
        sendStatusRequest('printer.objects.subscribe', objects)
      },
      Math.min(50, input.limits.requestTimeoutMs / 2),
    )
    // Optional RTC discovery precedes the subscription on the same connection.
    socket!.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER,
        method: 'printer.objects.list',
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
        nextId++
        queryTimeout = setTimeout(
          () => finish('stale'),
          Math.min(1000, input.limits.requestTimeoutMs),
        )
        try {
          if (socket!.bufferedAmount !== 0) throw Error('Outbound queue')
          sendStatusRequest('printer.objects.query', queryObjects)
        } catch {
          finish('offline')
        }
      },
      Math.max(0, 1000 - (performance.now() - lastRequestStarted)),
    )
  }
  let extensionId: number | undefined
  let extendSubscription = false
  function sendExtension() {
    if (!extendSubscription || pending || finished) return
    extendSubscription = false
    extensionId = ++nextId
    clearTimeout(queryTimer)
    queryTimeout = setTimeout(
      () => finish('stale'),
      input.limits.requestTimeoutMs,
    )
    sendStatusRequest('printer.objects.subscribe', objects)
  }
  let lastRequestStarted = 0
  const earlyUpdates: z.infer<typeof StatusUpdate>[] = []
  let earlyBytes = 0
  function message(data: import('ws').RawData, isBinary: boolean) {
    if (finished) return
    try {
      const value = decodeMoonrakerFrame(
        data,
        isBinary,
        input.limits.maxMessageBytes,
      )
      const reply = Reply.safeParse(value)
      if (!identified) {
        // An error reply, a malformed result or any other frame is a failed
        // identify: close and let the caller back off and reconnect.
        if (
          !reply.success ||
          reply.data.id !== IDENTIFY_ID ||
          !parseIdentifyResultSafe(reply.data.result)
        )
          throw new Error('Identify failed')
        identified = true
        begin()
        return
      }
      if (reply.success) {
        // Only the discovery request is outstanding until the base subscription.
        if (discovering && reply.data.id !== Number.MAX_SAFE_INTEGER) return
        if (
          input.discoverObjects &&
          reply.data.id === Number.MAX_SAFE_INTEGER
        ) {
          const wasDiscovering = discovering
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
                  name === 'output_pin caselight' ||
                  (input.jobFields &&
                    (/^extruder(?:[1-9][0-9]{0,2})?$/.test(name) ||
                      isChamberTemperatureObject(name))),
              )
              .map((name) => [
                name,
                /^extruder/.test(name) || name === 'heater_generic chamber'
                  ? ['temperature', 'target']
                  : isChamberTemperatureObject(name)
                    ? ['temperature']
                    : [name === 'output_pin caselight' ? 'value' : 'speed'],
              ]),
          )
          objects = { ...baseObjects, ...optional }
          queryObjects = { ...baseQueryObjects, ...optional }
          if (input.onComplete && listed.objects.includes('toolhead')) {
            const tools = selectToolObjects(listed)
            if (tools.some((name) => name !== 'extruder')) {
              delete queryObjects.extruder
              // Fields a caller already selected (the Snapmaker U1 tool
              // projection reads `target` and the active tool) must survive.
              for (const name of tools)
                queryObjects[name] = extraObjects[name] ?? ['temperature']
              queryObjects.toolhead = extraObjects.toolhead ?? ['extruder']
            }
          }
          discovering = false
          if (!wasDiscovering) {
            extendSubscription = true
            sendExtension()
            return
          }
          nextId++
          sendStatusRequest('printer.objects.subscribe', objects)
          return
        }
        if (
          !pending ||
          reply.data.id !== pending.id ||
          !Object.hasOwn(reply.data, 'result')
        )
          throw new Error('Unexpected reply')
        const received = performance.now()
        const { started, activeToolQuery } = pending
        if (
          received < started ||
          (input.onComplete &&
            received - started >= Math.min(1000, input.limits.requestTimeoutMs))
        )
          throw Error('Late observation')
        const replayAfter = earlyUpdates.length
          ? StatusResult.parse(reply.data.result).eventtime
          : undefined
        if (reply.data.id === extensionId) {
          const result = StatusResult.parse(reply.data.result)
          input.onStatus([result.status, result.eventtime])
          extensionId = undefined
        }
        pending = undefined
        lastRequestStarted = started
        clearTimeout(queryTimeout)
        input.onRequestSuccess?.(started, received)
        input.onComplete?.(
          Object.freeze({
            result: reply.data.result,
            activeToolQuery,
            requestStartedAtMonoMs: started,
            receivedAtMonoMs: received,
          }),
        )
        if (!subscribed) {
          subscribed = true
          clearTimeout(timer)
          resolveSnapshot(reply.data.result)
          if (replayAfter !== undefined) {
            // The async subscriber installs its baseline from the snapshot
            // continuation. Replay only updates newer than that snapshot.
            queueMicrotask(() => {
              if (finished) return
              try {
                for (const update of earlyUpdates)
                  if (update[1] > replayAfter) input.onStatus(update)
              } catch {
                finish('invalid-response')
              } finally {
                earlyUpdates.length = 0
              }
            })
          }
        }
        if (extendSubscription) sendExtension()
        else scheduleQuery()
        return
      }
      const notification = Notification.parse(value)
      if (notification.method === 'notify_status_update') {
        const update = StatusUpdate.parse(notification.params)
        if (subscribed) input.onStatus(update)
        else {
          // Moonraker delivers status asynchronously while the subscribe
          // reply is in flight. The frame decoder already requires a Buffer.
          if (!pending || discovering) throw Error('Status before subscription')
          earlyBytes += (data as Buffer).byteLength
          if (
            earlyBytes > input.limits.maxMessageBytes ||
            earlyUpdates.length >= 64
          )
            throw Error('Early status limit')
          earlyUpdates.push(update)
        }
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
