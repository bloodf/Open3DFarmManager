import {
  assertSignallingRuntimeBoundary,
  signallingBuildEnabled,
} from './signalling-build-policy.ts'
import { installSignallingWebSocketBounds } from './signalling-websocket-boundary.ts'
import { SignallingWebSocketResources } from './signalling-websocket-limits.ts'

/** Boundary preparation only: no routes, DB authority, or socket admissions are
 * installed here. A later runtime owns those and must use these resource limits. */
export function createSignallingBoundaryLifecycle() {
  let resources: SignallingWebSocketResources | undefined
  let closed = false
  return {
    start(input: {
      config: unknown
      buildEnabled: boolean
      nativeWebSocketCompiled: boolean
      preset: string
      h3App: unknown
    }): 'disabled' | 'prepared' {
      const enabled = signallingBuildEnabled(input.config)
      assertSignallingRuntimeBoundary({
        runtimeEnabled: enabled,
        buildEnabled: input.buildEnabled,
        nativeWebSocketCompiled: input.nativeWebSocketCompiled,
        preset: input.preset,
      })
      if (closed) throw new Error('Signalling boundary is closed')
      // An opted-in build keeps its adapter bounded even when runtime is disabled.
      // No private runtime flag can enable the adapter in an unprepared build.
      if (input.buildEnabled) {
        if (!input.nativeWebSocketCompiled || input.preset !== 'node-server')
          throw new Error('Unsupported signalling build boundary')
        installSignallingWebSocketBounds(input.h3App)
      }
      if (!enabled) return 'disabled'
      if (!resources)
        resources = new SignallingWebSocketResources({
          now: () => performance.now(),
          after(milliseconds, callback) {
            const timer = setTimeout(callback, milliseconds)
            timer.unref()
            return () => clearTimeout(timer)
          },
        })
      return 'prepared'
    },
    close(): void {
      closed = true
      resources?.dispose()
      resources = undefined
    },
  }
}
