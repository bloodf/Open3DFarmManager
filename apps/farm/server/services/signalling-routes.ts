import type { SignallingSocketRole } from './signalling-websocket-boundary.ts'
import { destroySignallingUpgrade } from './signalling-socket.ts'
import { signallingRuntime } from './signalling-runtime-bootstrap.ts'
/** H3's WebSocket resolver bypasses ordinary HTTP handlers/middleware. Every
 * upgrade therefore enters this boundary explicitly, including disabled startup. */
export function signallingSocketHooks(role: SignallingSocketRole) {
  return {
    async upgrade(request: unknown): Promise<Response | void> {
      const runtime = signallingRuntime()
      if (!runtime) {
        destroySignallingUpgrade(request)
        return new Response(null, { status: 403 })
      }
      return runtime.upgrade(request, role)
    },
    open(peer: unknown): void {
      signallingRuntime()?.open(peer)
    },
    message(peer: unknown, message: unknown): void {
      signallingRuntime()?.message(peer, message)
    },
    close(peer: unknown): void {
      signallingRuntime()?.disconnected(peer)
    },
    error(peer: unknown): void {
      signallingRuntime()?.disconnected(peer)
    },
  }
}
