import type { IncomingMessage } from 'node:http'
import type { SessionConfig } from 'nuxt/server'
import {
  inspectSignallingUpgrade,
  signallingBrowserSession,
  signallingNodeUpgrade,
  type SignallingSocketRole,
} from './signalling-websocket-boundary.ts'
import {
  destroySignallingUpgrade,
  signallingMessageText,
  signallingNativeSocket,
} from './signalling-socket.ts'
import type { SignallingSocketPort } from './signalling-websocket-limits.ts'
import type {
  ConfigurationSignallingCoordinator,
  ConfigurationSignallingTimers,
} from './configuration-signalling-coordinator.ts'
import {
  createConfigurationSocketSession,
  type ConfigurationSocketSession,
} from './configuration-signalling-session.ts'

type Connection = {
  role: SignallingSocketRole
  sessionRecordId?: string
  native: SignallingSocketPort | null
  session: ConfigurationSocketSession | null
  queue: string[]
  bytes: number
  running: boolean
  closed: boolean
  cancelOpen: () => void
}
const defaultTimers: ConfigurationSignallingTimers = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * WebSocket owner of the dedicated config-v1 signalling endpoints. It reuses
 * the maintained upgrade inspection, sealed-cookie unsealing and native socket
 * bounds, with its own subprotocol, paths and coordinator. It shares no state
 * with the pause/read-only runtime and cannot widen their admission.
 */
export class ConfigurationSignallingRuntime {
  readonly #origin: string
  readonly #cookie: SessionConfig
  readonly #coordinator: ConfigurationSignallingCoordinator
  readonly #timers: ConfigurationSignallingTimers
  readonly #connections = new Map<IncomingMessage, Connection>()
  #closed = false
  constructor(input: {
    origin: string
    cookie: SessionConfig
    coordinator: ConfigurationSignallingCoordinator
    timers?: ConfigurationSignallingTimers
  }) {
    this.#origin = input.origin
    this.#cookie = input.cookie
    this.#coordinator = input.coordinator
    this.#timers = input.timers ?? defaultTimers
  }
  get isClosed(): boolean {
    return this.#closed
  }
  async upgrade(
    input: unknown,
    role: SignallingSocketRole,
  ): Promise<Response | void> {
    let request: IncomingMessage | undefined
    try {
      if (this.#closed || this.#connections.size >= 64)
        throw new Error('Unavailable')
      request = inspectSignallingUpgrade(
        input,
        role,
        this.#origin,
        'configuration',
      ).request
      const connection: Connection = {
        role,
        native: null,
        session: null,
        queue: [],
        bytes: 0,
        running: false,
        closed: false,
        cancelOpen: () => {},
      }
      const owned = request
      this.#connections.set(owned, connection)
      owned.socket.once('close', () => this.#close(owned))
      connection.cancelOpen = this.#timers.after(8000, () => {
        if (!connection.native) {
          this.#close(owned)
          owned.socket.destroy()
        }
      })
      if (role === 'browser') {
        const session = await signallingBrowserSession(
          input,
          this.#origin,
          this.#cookie,
          'configuration',
        )
        if (connection.closed || this.#closed) throw new Error('Closed')
        connection.sessionRecordId = session.sessionRecordId
      }
    } catch {
      if (request) this.#close(request)
      destroySignallingUpgrade(input)
      return new Response(null, { status: 403 })
    }
  }
  open(peer: unknown): void {
    let request: IncomingMessage | undefined
    try {
      const native = signallingNativeSocket(peer, () => {
        if (request) this.#close(request)
      })
      request = native.request
      const connection = this.#connections.get(request)
      if (
        !connection ||
        connection.closed ||
        connection.native ||
        this.#closed ||
        (connection.role === 'browser' && !connection.sessionRecordId)
      ) {
        native.port.terminate()
        return
      }
      const owned = request
      connection.native = native.port
      connection.cancelOpen()
      connection.session = createConfigurationSocketSession({
        role: connection.role,
        sessionRecordId: connection.sessionRecordId,
        coordinator: this.#coordinator,
        timers: this.#timers,
        port: {
          send: (wire) => {
            const buffered = native.port.bufferedAmount()
            if (
              !Number.isSafeInteger(buffered) ||
              buffered + Buffer.byteLength(wire) > 64 * 1024
            )
              throw new Error('Socket backlog')
            native.port.send(wire)
          },
          close: () => this.#close(owned),
        },
      })
    } catch {
      if (request) this.#close(request)
    }
  }
  message(peer: unknown, message: unknown): void {
    const request = this.#request(peer)
    const connection = request && this.#connections.get(request)
    if (!request || !connection || connection.closed || !connection.session)
      return
    try {
      const text = signallingMessageText(message)
      const bytes = Buffer.byteLength(text)
      if (
        connection.queue.length + Number(connection.running) >= 8 ||
        connection.bytes + bytes > 32 * 1024
      )
        throw new Error('Inbound backlog')
      connection.queue.push(text)
      connection.bytes += bytes
      if (!connection.running) void this.#drain(connection)
    } catch {
      this.#close(request)
    }
  }
  disconnected(peer: unknown): void {
    const request = this.#request(peer)
    if (request) this.#close(request)
  }
  close(): void {
    this.#closed = true
    this.#coordinator.dispose()
    for (const request of [...this.#connections.keys()]) this.#close(request)
  }
  async #drain(connection: Connection): Promise<void> {
    connection.running = true
    try {
      while (!connection.closed && connection.queue.length) {
        const text = connection.queue.shift()!
        try {
          await connection.session?.receive(text)
        } finally {
          connection.bytes -= Buffer.byteLength(text)
        }
      }
    } finally {
      connection.running = false
    }
  }
  #request(peer: unknown): IncomingMessage | undefined {
    try {
      if (!peer || typeof peer !== 'object' || !('request' in peer))
        return undefined
      return signallingNodeUpgrade(peer.request)
    } catch {
      return undefined
    }
  }
  #close(request: IncomingMessage): void {
    const connection = this.#connections.get(request)
    if (!connection || connection.closed) return
    connection.closed = true
    this.#connections.delete(request)
    connection.queue.length = 0
    connection.cancelOpen()
    connection.session?.close()
    try {
      connection.native?.terminate()
    } catch {}
  }
}

/** Upgrades bypass HTTP middleware, so every hook fails closed without a runtime. */
export function configurationSocketHooks(
  role: SignallingSocketRole,
  lookup: () => ConfigurationSignallingRuntime | undefined,
  serving: () => boolean,
) {
  const owners = new WeakMap<IncomingMessage, ConfigurationSignallingRuntime>()
  function owner(peer: unknown) {
    try {
      if (!peer || typeof peer !== 'object' || !('request' in peer))
        return undefined
      return owners.get(signallingNodeUpgrade(peer.request))
    } catch {
      return undefined
    }
  }
  return {
    async upgrade(request: unknown): Promise<Response | void> {
      const runtime = serving() ? lookup() : undefined
      if (!runtime) {
        destroySignallingUpgrade(request)
        return new Response(null, { status: serving() ? 403 : 503 })
      }
      const result = await runtime.upgrade(request, role)
      if (result) return result
      const raw = signallingNodeUpgrade(request)
      if (raw.socket.destroyed || runtime.isClosed || lookup() !== runtime) {
        runtime.disconnected({ request })
        destroySignallingUpgrade(request)
        return new Response(null, { status: 403 })
      }
      owners.set(raw, runtime)
    },
    open(peer: unknown): void {
      const runtime = owner(peer)
      if (runtime) runtime.open(peer)
      else
        try {
          signallingNativeSocket(peer, () => {}).port.terminate()
        } catch {}
    },
    message(peer: unknown, message: unknown): void {
      owner(peer)?.message(peer, message)
    },
    close(peer: unknown): void {
      owner(peer)?.disconnected(peer)
    },
    error(peer: unknown): void {
      owner(peer)?.disconnected(peer)
    },
  }
}
