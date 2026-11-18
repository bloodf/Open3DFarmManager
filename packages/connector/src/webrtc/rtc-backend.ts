/**
 * Startup probe for the Connector's WebRTC backend.
 *
 * Every RTC peer (control, configuration, read-only, camera) uses the native
 * `node-datachannel` addon, whose binary ships in an optional platform
 * package. A registry mirror that lacks that package makes npm skip it without
 * an error, so the failure would otherwise appear only at the first browser
 * connection. The probe loads the module once, at startup, and reports the
 * result with a fixed vocabulary. It never exposes an error message or path.
 *
 * No second backend exists yet (see docs/RTC-BACKEND-DECISION.md). Without the
 * native module the Connector runs in `read-only-degraded` mode: telemetry,
 * the local status page and every local safety check keep working, but no
 * browser RTC session (pause, configuration, farm view, camera) is offered.
 * There is no TURN, no relay and no command fallback.
 */

export type RtcBackendName = 'node-datachannel' | 'none'
export type RtcBackendMode = 'direct' | 'read-only-degraded'
export type RtcBackendReason = 'native-binary-missing' | 'native-load-failed'

export type RtcBackendStatus = Readonly<{
  backend: RtcBackendName
  mode: RtcBackendMode
  /** Present only when `backend` is `none`. */
  reason?: RtcBackendReason
}>

export type RtcModuleLoader = () => Promise<unknown>

const MISSING_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])

function classifyFailure(error: unknown): RtcBackendReason {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  const message = error instanceof Error ? error.message : ''
  // Missing optional package, or a package present without its `.node` file.
  if (
    MISSING_CODES.has(code) ||
    /cannot find (module|package)|\.node['"]?/i.test(message)
  )
    return 'native-binary-missing'
  return 'native-load-failed'
}

export const RTC_BACKEND_DIRECT: RtcBackendStatus = Object.freeze({
  backend: 'node-datachannel',
  mode: 'direct',
})

/**
 * Loads the native module once and reports which backend is active. The
 * loader is injectable so tests can simulate an absent binary without touching
 * the install tree.
 */
export async function probeRtcBackend(
  load: RtcModuleLoader = () => import('node-datachannel'),
): Promise<RtcBackendStatus> {
  try {
    const module = (await load()) as { PeerConnection?: unknown } | null
    if (typeof module?.PeerConnection !== 'function')
      return Object.freeze({
        backend: 'none',
        mode: 'read-only-degraded',
        reason: 'native-load-failed',
      })
    return RTC_BACKEND_DIRECT
  } catch (error) {
    return Object.freeze({
      backend: 'none',
      mode: 'read-only-degraded',
      reason: classifyFailure(error),
    })
  }
}
