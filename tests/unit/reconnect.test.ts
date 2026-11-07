import { expect, test, vi } from 'vitest'
import {
  SignallingBackoff,
  waitForReconnect,
} from '../../packages/connector/src/cloud/reconnect.ts'

test('long outages never produce a tight retry loop or an unbounded delay', () => {
  for (const sample of [0, 0.5, 1 - Number.EPSILON]) {
    const backoff = new SignallingBackoff(() => sample)
    expect(backoff.nextDelay()).toBe(1000)
    for (let failure = 0; failure < 10_000; failure++) {
      const delay = backoff.nextDelay()
      expect(Number.isSafeInteger(delay)).toBe(true)
      expect(delay).toBeGreaterThanOrEqual(1000)
      expect(delay).toBeLessThanOrEqual(60_000)
    }
  }
})
test('jitter spreads saturated clients across a bounded interval', () => {
  const delays = [0, 0.25, 0.5, 0.75, 1 - Number.EPSILON].map((sample) => {
    const backoff = new SignallingBackoff(() => sample)
    for (let attempt = 0; attempt < 10; attempt++) backoff.nextDelay()
    return backoff.nextDelay()
  })
  expect(new Set(delays).size).toBe(5)
  expect(Math.min(...delays)).toBe(30_000)
  expect(Math.max(...delays)).toBe(60_000)
})
test('brief authenticated reconnects retain pressure; stable uptime resets it', () => {
  const backoff = new SignallingBackoff(() => 0.5)
  for (let attempt = 0; attempt < 10; attempt++) backoff.nextDelay()
  backoff.recordAuthenticatedUptime(29_999)
  expect(backoff.nextDelay()).toBeGreaterThanOrEqual(30_000)
  backoff.recordAuthenticatedUptime(30_000)
  expect(backoff.nextDelay()).toBe(1000)
})
test('invalid random output does not mutate retry progression', () => {
  let sample = NaN
  const backoff = new SignallingBackoff(() => sample)
  for (sample of [NaN, Infinity, -0.1, 1])
    expect(() => backoff.nextDelay()).toThrow()
  sample = 0.5
  expect(backoff.nextDelay()).toBe(1000)
  for (const duration of [NaN, Infinity, -1])
    expect(() => backoff.recordAuthenticatedUptime(duration)).toThrow()
})
test('aborted shutdown cancels a pending long wait immediately and preserves the reason', async () => {
  const controller = new AbortController()
  const reason = new Error('shutdown')
  const pending = waitForReconnect(60_000, controller.signal)
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  await expect(waitForReconnect(1000, controller.signal)).rejects.toBe(reason)
})
test('completed wait removes its listener and rejects invalid timer bounds', async () => {
  const controller = new AbortController()
  const add = vi.spyOn(controller.signal, 'addEventListener')
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  try {
    await waitForReconnect(0, controller.signal)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
  } finally {
    add.mockRestore()
    remove.mockRestore()
  }
  controller.abort()
  for (const delay of [-1, 60_001, NaN, Infinity, 1.1])
    await expect(
      waitForReconnect(delay, new AbortController().signal),
    ).rejects.toThrow('Invalid reconnect delay')
})
