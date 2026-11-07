import { afterEach, expect, test, vi } from 'vitest'
import {
  CAMERA_LOADING_TIMEOUT_MS,
  createCameraDisplaySession,
  type CameraDisplayState,
} from '../../apps/farm/app/utils/camera-display.ts'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  const states: CameraDisplayState[] = []
  const detach = vi.fn()
  const session = createCameraDisplaySession({
    changed: (state) => states.push(state),
    detach,
  })
  return { session, states, detach }
}

test('a camera that never plays leaves loading after ten seconds and detaches once', () => {
  const { session, states, detach } = fixture()
  vi.advanceTimersByTime(CAMERA_LOADING_TIMEOUT_MS - 1)
  expect(states).toEqual(['loading'])
  vi.advanceTimersByTime(1)
  expect(states).toEqual(['loading', 'error'])
  expect(detach).toHaveBeenCalledTimes(1)
  session.ready()
  session.fail()
  expect(states).toEqual(['loading', 'error'])
  session.close()
  session.close()
  expect(detach).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('playing cancels the loading deadline; a media error still detaches', () => {
  const { session, states, detach } = fixture()
  session.ready()
  vi.advanceTimersByTime(CAMERA_LOADING_TIMEOUT_MS * 2)
  expect(states).toEqual(['loading', 'ready'])
  expect(detach).not.toHaveBeenCalled()
  session.fail()
  expect(states).toEqual(['loading', 'ready', 'error'])
  expect(detach).toHaveBeenCalledTimes(1)
})

test('replacement/unmount cancels the old deadline and ignores late events', () => {
  const old = fixture()
  old.session.close()
  const next = fixture()
  old.session.ready()
  old.session.fail()
  next.session.ready()
  vi.advanceTimersByTime(CAMERA_LOADING_TIMEOUT_MS)
  expect(old.states).toEqual(['loading', 'closed'])
  expect(old.detach).toHaveBeenCalledTimes(1)
  expect(next.states).toEqual(['loading', 'ready'])
  next.session.close()
  expect(next.detach).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('reentrant close during failure detaches once and publishes closed once', () => {
  vi.useFakeTimers()
  const states: CameraDisplayState[] = []
  const detach = vi.fn(() => session.close())
  const session = createCameraDisplaySession({
    changed: (state) => states.push(state),
    detach,
  })
  session.fail()
  session.ready()
  expect(states).toEqual(['loading', 'closed'])
  expect(detach).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
