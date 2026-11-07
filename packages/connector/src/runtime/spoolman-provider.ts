import WebSocket from 'ws'
import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { SpoolmanConfig } from '../spoolman/config.ts'
import { createBoundedSpoolmanReader } from '../spoolman/bounded-read.ts'

type Inventory = Awaited<
  ReturnType<ReturnType<typeof createBoundedSpoolmanReader>>
>
export type SpoolmanSnapshot = Readonly<{
  kind: 'unavailable' | 'stale' | 'observed'
  inventory: Inventory | null
  ageMs: number | null
}>
const Event = z.object({
  type: z.enum(['added', 'updated', 'deleted']),
  resource: z.enum(['spool', 'filament', 'vendor']),
  date: z.string().max(128),
  payload: z.unknown(),
})

/** Owned by the maintained collector. One socket, one traversal, one pending invalidation. */
export function createSpoolmanProvider(input: {
  config: SpoolmanConfig
  signal: AbortSignal
  onSnapshot?: (value: SpoolmanSnapshot) => void
  transport?: {
    fetch?: typeof fetch
    socket?: (url: string) => WebSocket
    now?: () => number
  }
}) {
  const config = SpoolmanConfig.parse(input.config)
  const now = input.transport?.now ?? (() => performance.now())
  const reader = createBoundedSpoolmanReader({
    origin: config.origin,
    context: {
      farmId: config.farmId,
      serviceId: config.serviceId,
      limit: config.limit,
    },
    timeoutMs: 10_000,
    ...(input.transport?.fetch ? { fetch: input.transport.fetch } : {}),
  })
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let active: Promise<void> | undefined
  let inventory: Inventory | null = null
  let observedAt: number | null = null
  let stale = true,
    dirty = true,
    closed = false,
    connected = false
  let generation = 0,
    failures = 0,
    nextRead = 0,
    pongAt = 0
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  function snapshot(): SpoolmanSnapshot {
    const ageMs = observedAt === null ? null : Math.max(0, now() - observedAt)
    return structuredClone({
      kind:
        inventory === null
          ? 'unavailable'
          : stale || !connected || ageMs === null || ageMs >= 30_000
            ? 'stale'
            : 'observed',
      inventory,
      ageMs,
    })
  }
  function publish() {
    try {
      input.onSnapshot?.(snapshot())
    } catch {
      close()
    }
  }
  function scheduleRead() {
    if (closed || !connected || active || refreshTimer) return
    refreshTimer = setTimeout(
      () => {
        refreshTimer = undefined
        if (closed || !connected) return
        const epoch = generation
        dirty = false
        nextRead = now() + 1000
        active = (async () => {
          try {
            const value = await reader(signal)
            if (closed || epoch !== generation || dirty || !connected) return
            inventory = value
            observedAt = now()
            stale = false
            failures = 0
            publish()
          } catch {
            if (!closed) {
              stale = true
              dirty = true
              failures = Math.min(5, failures + 1)
              publish()
            }
          } finally {
            active = undefined
            if (!closed) {
              nextRead = Math.max(
                nextRead,
                now() +
                  (dirty ? Math.min(30_000, 1000 * 2 ** failures) : 15_000),
              )
              scheduleRead()
            }
          }
        })()
      },
      Math.max(0, nextRead - now()),
    )
  }
  function invalidate() {
    if (closed) return
    dirty = true
    const changed = !stale
    stale = true
    if (changed) publish()
    scheduleRead()
  }
  function detach() {
    clearInterval(heartbeat)
    clearTimeout(timer)
    const previous = socket
    socket = undefined
    if (previous) {
      previous.removeAllListeners()
      // ws can emit an error after terminating a connecting socket.
      if (previous.readyState !== WebSocket.CLOSED) {
        const swallow = () => {}
        previous.on('error', swallow)
        previous.once('close', () => previous.removeListener('error', swallow))
        previous.terminate()
      }
    }
  }
  function disconnected() {
    if (closed) return
    generation++
    connected = false
    detach()
    invalidate()
    if (closed) return
    failures = Math.min(5, failures + 1)
    timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** failures))
  }
  function connect() {
    if (closed) return
    const url = new URL('/api/v1/', config.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      socket =
        input.transport?.socket?.(url.href) ??
        new WebSocket(url, {
          followRedirects: false,
          handshakeTimeout: 5000,
          maxPayload: 256 * 1024,
          perMessageDeflate: false,
        })
      socket.on('error', disconnected)
      socket.on('close', disconnected)
      socket.on('open', () => {
        connected = true
        pongAt = now()
        invalidate()
        if (closed) return
        heartbeat = setInterval(() => {
          if (now() - pongAt >= 15_000) {
            disconnected()
            return
          }
          socket?.ping()
        }, 5000)
      })
      socket.on('pong', () => {
        pongAt = now()
      })
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw Error()
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data)
          if (bytes.byteLength > 256 * 1024) throw Error()
          const value = parseBoundedJson(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            {
              maxBytes: 256 * 1024,
              maxDepth: 12,
              maxValues: 20_000,
              maxStringChars: 4096,
            },
          )
          if (Event.safeParse(value).success) invalidate()
        } catch {
          disconnected()
        }
      })
    } catch {
      disconnected()
    }
  }
  function close() {
    if (closed) return
    closed = true
    connected = false
    stale = true
    controller.abort()
    detach()
    clearTimeout(refreshTimer)
    input.signal.removeEventListener('abort', close)
    void (active ?? Promise.resolve()).finally(finish)
  }
  input.signal.addEventListener('abort', close, { once: true })
  if (input.signal.aborted) close()
  else connect()
  return { snapshot, close, done }
}
