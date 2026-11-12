import type { SignallingSocketRole } from './signalling-websocket-boundary.ts'
import { signallingNodeUpgrade } from './signalling-websocket-boundary.ts'
import {
  destroySignallingUpgrade,
  signallingNativeSocket,
} from './signalling-socket.ts'
import { signallingRuntime } from './signalling-runtime-bootstrap.ts'
import type { SignallingMode } from './signalling-negotiation-adapter.ts'
import type { IncomingMessage } from 'node:http'
import { databaseServing } from '../utils/database/phase.ts'
/** H3's WebSocket resolver bypasses ordinary HTTP handlers/middleware. Every
 * upgrade therefore enters this boundary explicitly, including disabled startup. */
export function signallingSocketHooks(
  role: SignallingSocketRole,
  mode: SignallingMode = 'read-only',
  lookup = signallingRuntime,
) {
  const owners = new WeakMap<
    IncomingMessage,
    NonNullable<ReturnType<typeof lookup>>
  >()
  function owned(peer: unknown) {
    if (!peer || typeof peer !== 'object' || !('request' in peer))
      return undefined
    try {
      const request = signallingNodeUpgrade(peer.request)
      return { request, runtime: owners.get(request) }
    } catch {
      return undefined
    }
  }
  function disconnected(peer: unknown) {
    const value = owned(peer)
    if (!value) return
    value.runtime?.disconnected(peer)
    owners.delete(value.request)
  }
  return {
    async upgrade(request: unknown): Promise<Response | void> {
      // Upgrades bypass middleware: refuse until the schema gate has passed.
      if (!databaseServing()) {
        destroySignallingUpgrade(request)
        return new Response(null, { status: 503 })
      }
      const runtime = lookup()
      if (!runtime) {
        destroySignallingUpgrade(request)
        return new Response(null, { status: 403 })
      }
      const result = await runtime.upgrade(request, role, mode)
      if (result) return result
      const raw = signallingNodeUpgrade(request)
      if (raw.socket.destroyed || runtime.isClosed || lookup() !== runtime) {
        runtime.disconnected({ request })
        destroySignallingUpgrade(request)
        return new Response(null, { status: 403 })
      }
      owners.set(raw, runtime)
      raw.socket.once('close', () => owners.delete(raw))
    },
    open(peer: unknown): void {
      const runtime = owned(peer)?.runtime
      if (runtime) runtime.open(peer)
      else {
        try {
          signallingNativeSocket(peer, () => {}).port.terminate()
        } catch {}
      }
    },
    message(peer: unknown, message: unknown): void {
      owned(peer)?.runtime?.message(peer, message)
    },
    close(peer: unknown): void {
      disconnected(peer)
    },
    error(peer: unknown): void {
      disconnected(peer)
    },
  }
}
