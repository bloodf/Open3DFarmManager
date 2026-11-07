export type CameraDisplayState = 'loading' | 'ready' | 'error' | 'closed'

export const CAMERA_LOADING_TIMEOUT_MS = 10_000

// Rendering only. The caller owns authorization, transport and media tracks.
export function createCameraDisplaySession(input: {
  changed(state: CameraDisplayState): void
  detach(): void
}) {
  let state: CameraDisplayState = 'loading'
  let detached = false
  const detach = () => {
    if (detached) return
    detached = true
    input.detach()
  }
  const fail = () => {
    if (state === 'error' || state === 'closed') return
    clearTimeout(timer)
    state = 'error'
    detach()
    input.changed(state)
  }
  const timer = setTimeout(fail, CAMERA_LOADING_TIMEOUT_MS)
  input.changed(state)
  return {
    ready() {
      if (state !== 'loading') return
      clearTimeout(timer)
      state = 'ready'
      input.changed(state)
    },
    fail,
    close() {
      if (state === 'closed') return
      clearTimeout(timer)
      state = 'closed'
      detach()
      input.changed(state)
    },
  }
}
