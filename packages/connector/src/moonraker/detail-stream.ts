import { setTimeout as delay } from 'node:timers/promises'
import {
  moonrakerAuthHeaders,
  moonrakerSession,
  type MoonrakerLimits,
} from '../config/moonraker.ts'
import { PrinterDetailUpdate } from '../../../farm-protocol/src/printer-detail.ts'
import {
  fields,
  list,
  normalizeDetail,
  selectDetailObjects,
  string,
  type Fields,
} from './detail-normalize.ts'
import { createMoonrakerSocket } from './socket.ts'

export { count, fields, fraction, list, string } from './detail-normalize.ts'

/** 4 Hz: at most one update frame per 250 ms. */
export const DETAIL_MIN_INTERVAL_MS = 250
const MAX_PENDING_REQUESTS = 16
const MAX_CONSOLE_LINES = 256
const MAX_FRAME_LINES = 64
const MAX_CONFIG_BYTES = 65_536

export class MoonrakerRpcError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'MoonrakerRpcError'
    this.code = code
  }
}

export type DetailListener = (frame: unknown) => void
export type MoonrakerDetailStream = ReturnType<
  typeof createMoonrakerDetailStream
>

/**
 * One lazy, reference-counted detail connection for one printer. The
 * connection (and its object subscription) exists only while at least one
 * listener is subscribed; the last unsubscribe tears it down.
 */
export function createMoonrakerDetailStream(input: {
  printerKey: string
  origin: string
  limits: MoonrakerLimits
}) {
  const listeners = new Set<DetailListener>()
  let lifetime: AbortController | undefined
  let latest: unknown
  let seq = 0
  let rpc: ((method: string, params?: Fields) => Promise<unknown>) | undefined

  const emit = (frame: unknown) => {
    for (const listener of [...listeners]) listener(frame)
  }

  async function connect(signal: AbortSignal): Promise<boolean> {
    const authenticatedUrl = await moonrakerSession(
      input.origin,
      input.limits,
    )?.getWebsocketUrl()
    signal.throwIfAborted()
    const socket = createMoonrakerSocket(input.origin, input.limits, {
      allowSynchronousEvents: false,
      ...(authenticatedUrl ? { authenticatedUrl } : {}),
    })
    const pending = new Map<number, (reply?: Fields) => void>()
    const status = new Map<string, Fields>()
    let id = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let selected = new Set<string>()
    let ready = false
    let everReady = false
    let lastEvent = -Infinity
    let lastUpdate = -Infinity
    const abort = () => socket.terminate()
    signal.addEventListener('abort', abort, { once: true })

    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        ready = false
        if (rpc === request) {
          rpc = undefined
          latest = undefined
        }
        clearTimeout(timer)
        timer = undefined
        for (const settle of [...pending.values()]) settle()
        signal.removeEventListener('abort', abort)
        resolve()
      }),
    )
    socket.on('error', abort)

    function request(method: string, params?: Fields) {
      return new Promise<unknown>((resolve, reject) => {
        if (
          signal.aborted ||
          socket.readyState !== socket.OPEN ||
          pending.size >= MAX_PENDING_REQUESTS
        ) {
          reject(new MoonrakerRpcError('Moonraker unavailable'))
          return
        }
        const requestId = ++id
        const timeout = setTimeout(
          () => settle(),
          input.limits.requestTimeoutMs,
        )
        function settle(reply?: Fields) {
          clearTimeout(timeout)
          pending.delete(requestId)
          if (reply && 'result' in reply) resolve(reply.result)
          else {
            const error = fields(reply?.error)
            reject(
              new MoonrakerRpcError(
                'Moonraker query failed',
                typeof error.code === 'number' ? error.code : undefined,
              ),
            )
          }
        }
        pending.set(requestId, settle)
        socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
          (error) => {
            if (error) settle()
          },
        )
      })
    }

    let metadataFile = ''
    let metadata: Fields = {}
    function publish() {
      timer = undefined
      if (signal.aborted || !ready) return
      lastUpdate = performance.now()
      const print = status.get('print_stats')
      const file = string(print?.filename, 512)
      if (file !== metadataFile) {
        metadataFile = file
        metadata = {}
        if (file)
          void request('server.files.metadata', { filename: file })
            .then((result) => {
              if (!ready || metadataFile !== file) return
              const value = fields(result)
              metadata = {
                estimated_time: value.estimated_time,
                filament_total: value.filament_total,
              }
              schedulePublish()
            })
            .catch(() => {})
      }
      const enriched = new Map(status)
      if (print) enriched.set('print_stats', { ...print, ...metadata })
      const frame = PrinterDetailUpdate.safeParse({
        v: 1,
        t: 'detail.update',
        printerKey: input.printerKey,
        seq: seq++,
        ...normalizeDetail(enriched),
      })
      if (!frame.success) return
      latest = frame.data
      emit(latest)
    }

    function schedulePublish() {
      if (timer) return
      const wait = DETAIL_MIN_INTERVAL_MS - (performance.now() - lastUpdate)
      timer = setTimeout(publish, Math.max(0, Math.ceil(wait)))
    }

    function merge(delta: unknown, eventtime: unknown) {
      if (typeof eventtime !== 'number' || eventtime < lastEvent) return false
      lastEvent = eventtime
      for (const [key, value] of Object.entries(fields(delta)))
        if (selected.has(key))
          status.set(key, { ...status.get(key), ...fields(value) })
      return true
    }

    function forwardConsole(text: string) {
      const lines = text
        .split(/\r?\n/, MAX_CONSOLE_LINES)
        .map((line) => string(line, 2048))
        .filter(Boolean)
      for (let start = 0; start < lines.length; start += MAX_FRAME_LINES)
        emit({
          v: 1,
          t: 'detail.gcode_response',
          printerKey: input.printerKey,
          seq: seq++,
          lines: lines.slice(start, start + MAX_FRAME_LINES),
        })
    }

    socket.on('message', (raw, binary) => {
      if (signal.aborted || binary) return
      let frame: Fields
      try {
        frame = fields(JSON.parse(raw.toString()))
      } catch {
        abort()
        return
      }
      if (frame.jsonrpc !== '2.0') return
      if (typeof frame.id === 'number') {
        pending.get(frame.id)?.(frame)
        return
      }
      if (!ready) return
      const [data, eventtime] = list(frame.params)
      switch (frame.method) {
        case 'notify_status_update':
          if (merge(data, eventtime)) schedulePublish()
          break
        case 'notify_gcode_response':
          if (typeof data === 'string') forwardConsole(data)
          break
        case 'notify_klippy_disconnected':
        case 'notify_klippy_shutdown':
          abort()
          break
      }
    })

    socket.once('open', () => {
      void (async () => {
        await request('server.connection.identify', {
          client_name: 'Open3DFarmManager Detail',
          version: '1',
          type: 'agent',
          url: 'https://open3dfarmmanager.local',
        })
        const objects = fields(await request('printer.objects.list')).objects
        selected = new Set(selectDetailObjects(objects))
        const initial = fields(
          await request('printer.objects.subscribe', {
            objects: Object.fromEntries(
              [...selected].map((name) => [name, null]),
            ),
          }),
        )
        if (signal.aborted || socket.readyState !== socket.OPEN) return
        merge(initial.status, initial.eventtime)
        rpc = request
        ready = everReady = true
        publish()
      })().catch(abort)
    })
    await closed
    return everReady
  }

  async function run(signal: AbortSignal) {
    let backoff = input.limits.reconnectMinMs
    while (!signal.aborted) {
      const wasReady = await connect(signal).catch(() => false)
      backoff = wasReady
        ? input.limits.reconnectMinMs
        : Math.min(input.limits.reconnectMaxMs, backoff * 2)
      await delay(wasReady ? input.limits.reconnectMinMs : backoff, undefined, {
        signal,
      }).catch(() => {})
    }
  }

  return {
    /** Start (or share) the detail connection. Returns an idempotent stop. */
    subscribe(listener: DetailListener) {
      listeners.add(listener)
      if (!lifetime) {
        lifetime = new AbortController()
        void run(lifetime.signal)
      }
      if (latest) listener(latest)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        listeners.delete(listener)
        if (listeners.size) return
        lifetime?.abort()
        lifetime = undefined
        rpc = undefined
        latest = undefined
      }
    },
    /** True while a detail connection is wanted. For tests and diagnostics. */
    get active() {
      return lifetime !== undefined
    },
    /** Moonraker JSON-RPC over the detail connection; rejects when nobody watches. */
    request(method: string, params?: Fields): Promise<unknown> {
      return (
        rpc?.(method, params) ??
        Promise.reject(new MoonrakerRpcError('Moonraker unavailable'))
      )
    },
    async readConfig(path: string, signal: AbortSignal) {
      const parts = path.split('/')
      if (
        !path.endsWith('.cfg') ||
        parts.some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[\\\x00-\x1f]/.test(part),
        )
      )
        throw new Error('Invalid config path')
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(input.limits.requestTimeoutMs),
      ])
      const response = await fetch(
        new URL(
          '/server/files/config/' + parts.map(encodeURIComponent).join('/'),
          input.origin,
        ),
        {
          signal: deadline,
          redirect: 'error',
          credentials: 'omit',
          headers: await (moonrakerSession(
            input.origin,
            input.limits,
          )?.getAuthHeaders() ??
            moonrakerAuthHeaders(input.origin, input.limits)),
        },
      )
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('Config unavailable')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_CONFIG_BYTES) throw new RangeError('Config too large')
          chunks.push(value)
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        )
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
  }
}
