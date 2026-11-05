import { sameCameraScope } from './source-policy.ts'
import type { CameraScope, LocalCameraRegistry } from './source-policy.ts'

export type CameraAccessUnit = Readonly<{
  data: Uint8Array
  keyframe: boolean
  timestampUs: number
}>

export type CameraLease = Readonly<{
  cameraId: string
  scope: CameraScope
  expiresAt: number
  signal: AbortSignal
}>

export type CameraSink = {
  trySend(unit: CameraAccessUnit): 'sent' | 'backpressured' | 'closed'
  close(): void
}

export function startCameraSession({
  cameraId,
  scope,
  lease,
  registry,
  openSource,
  sink,
}: {
  cameraId: string
  scope: CameraScope
  lease: CameraLease
  registry: LocalCameraRegistry
  openSource(
    handle: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<CameraAccessUnit>>
  sink: CameraSink
}): { done: Promise<void>; stop(): void } {
  const sessionScope = { ...scope }
  const expiresAt = lease.expiresAt
  const leaseSignal = lease.signal
  const leaseCameraId = lease.cameraId
  const leaseScope = { ...lease.scope }
  const controller = new AbortController()
  let stopped = false
  let iterator: AsyncIterator<CameraAccessUnit> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let release: () => void = () => {}
  const stoppedPromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
    leaseSignal.removeEventListener('abort', stop)
    try {
      sink.close()
    } catch {
      /* Cleanup must continue. */
    }
    if (iterator?.return) {
      try {
        Promise.resolve(iterator.return()).catch(() => {})
      } catch {
        /* Cleanup is best effort. */
      }
    }
    release()
  }
  const active = () =>
    !stopped && !leaseSignal.aborted && performance.now() < expiresAt
  const done = (async () => {
    try {
      const now = performance.now()
      const handle = registry.resolve({ cameraId, scope: sessionScope })
      if (
        !handle ||
        leaseCameraId !== cameraId ||
        !sameCameraScope(sessionScope, leaseScope) ||
        leaseSignal.aborted ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        expiresAt - now > 30_000
      )
        return
      leaseSignal.addEventListener('abort', stop, { once: true })
      timer = setTimeout(stop, expiresAt - now)
      if (!active()) return
      const sourcePromise = openSource(handle, controller.signal)
      const source = await Promise.race([
        sourcePromise,
        stoppedPromise.then(() => undefined),
      ])
      if (!source) {
        void sourcePromise
          .then((late) => {
            try {
              Promise.resolve(late[Symbol.asyncIterator]().return?.()).catch(
                () => {},
              )
            } catch {
              /* Late source cleanup. */
            }
          })
          .catch(() => {})
        return
      }
      iterator = source[Symbol.asyncIterator]()
      if (!active()) return
      let bytes = 0
      let windowStart = performance.now()
      let windowCount = 0
      let windowBytes = 0
      let lastTimestamp = -1
      while (active()) {
        const result = await Promise.race([
          iterator.next(),
          stoppedPromise.then(() => undefined),
        ])
        if (!result || !active() || result.done) return
        const unit = result.value
        const { data, keyframe, timestampUs } = unit
        const current = performance.now()
        if (current - windowStart >= 1000) {
          windowStart = current
          windowCount = 0
          windowBytes = 0
        }
        if (
          !(data instanceof Uint8Array) ||
          !data.byteLength ||
          data.byteLength > 262_144 ||
          typeof keyframe !== 'boolean' ||
          !Number.isSafeInteger(timestampUs) ||
          timestampUs < 0 ||
          timestampUs <= lastTimestamp ||
          ++windowCount > 30 ||
          (windowBytes += data.byteLength) > 1_048_576 ||
          (bytes += data.byteLength) > 67_108_864
        )
          return
        lastTimestamp = timestampUs
        if (
          sink.trySend({ data: data.slice(), keyframe, timestampUs }) !== 'sent'
        )
          return
      }
    } catch {
      // Source and sink errors must not expose local configuration.
    } finally {
      stop()
    }
  })()
  return { done, stop }
}
