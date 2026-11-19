import { randomUUID } from 'node:crypto'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { expect, it, vi } from 'vitest'
import {
  createPrinterLinkHealth,
  encodeLinkHealthFrames,
  startLinkHealthHeartbeat,
} from '../../packages/connector/src/runtime/link-health.ts'
import type { ConnectorLinkHealth } from '../../packages/farm-protocol/src/link-health.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const connector: ConnectorLinkHealth = {
  version: '1.2.3',
  uptimeMs: 60_000,
  queueBacklog: 4,
  storage: 'degraded',
  rtcScope: 'loopback',
}

it('measures delayed requests and records dropped links and reconnects', async () => {
  const mock = await startMoonrakerMock()
  try {
    let now = 0
    const health = createPrinterLinkHealth(
      'printer',
      () => now,
      () => 123,
    )
    const request = async () => {
      const response = await fetch(mock.origin + '/server/info', {
        signal: AbortSignal.timeout(2000),
      })
      expect(response.ok).toBe(true)
      await response.arrayBuffer()
    }
    await request()
    now = 10
    health.success(0)

    mock.control.faults.setFault({ type: 'drop' })
    await expect(request()).rejects.toThrow()
    health.failure('connection-reset')
    expect(health.read().state).toBe('offline')
    health.reconnect()
    expect(health.read().state).toBe('reconnecting')

    mock.control.faults.setFault({ type: 'delay', delayMs: 50 })
    const start = performance.now()
    await request()
    const elapsed = Math.round(performance.now() - start)
    expect(elapsed).toBeGreaterThanOrEqual(45)
    now = 10 + elapsed
    health.success(10)
    expect(health.read()).toEqual({
      printerKey: 'printer',
      state: 'connected',
      lastSuccessAt: 123,
      p50Ms: 10,
      p95Ms: elapsed,
      reconnects: 1,
      lastErrorCode: 'connection-reset',
    })
    now += 60_000
    expect(health.read()).toMatchObject({
      p50Ms: null,
      p95Ms: null,
      reconnects: 1,
    })
    now = 3_600_010
    expect(health.read().reconnects).toBe(0)
  } finally {
    await mock.close()
  }
})

it('preserves 100 printers in bounded snapshot frames', () => {
  const printers = Array.from({ length: 100 }, (_, index) =>
    createPrinterLinkHealth(String(index).padEnd(128, '界')).read(),
  )
  const frames = encodeLinkHealthFrames(
    'link-health-snapshot',
    123,
    connector,
    printers,
  )
  expect(frames.every((frame) => Buffer.byteLength(frame) <= 2048)).toBe(true)
  expect(frames.flatMap((frame) => JSON.parse(frame).printers)).toEqual(
    printers,
  )
  expect(frames.map((frame) => JSON.parse(frame).page)).toEqual(
    frames.map((_, i) => i + 1),
  )
})

it('emits one heartbeat every 60 seconds until aborted', () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  try {
    const emit = vi.fn()
    startLinkHealthHeartbeat(
      () => ({ connector, printers: [] }),
      emit,
      controller.signal,
    )
    vi.advanceTimersByTime(59_999)
    expect(emit).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(JSON.parse(emit.mock.calls[0]![0][0])).toMatchObject({
      kind: 'link-health-heartbeat',
      connector,
    })
    vi.advanceTimersByTime(60_000)
    expect(emit).toHaveBeenCalledTimes(2)
    controller.abort()
    vi.advanceTimersByTime(60_000)
    expect(emit).toHaveBeenCalledTimes(2)
  } finally {
    controller.abort()
    vi.useRealTimers()
  }
})

it('reports delayed and dropped Moonraker exchanges through the live snapshot provider', async () => {
  const mock = await startMoonrakerMock()
  const controller = new AbortController()
  const printerKey = 'printer'
  const agentId = randomUUID()
  const assignmentRefs = [{ printerKey, agentId, assignmentId: randomUUID() }]
  const health = createPrinterLinkHealth(printerKey)
  const source = createFarmSnapshotSource({
    assignmentRefs,
    linkHealthFor() {
      const { printerKey: _printerKey, ...status } = health.read()
      return status
    },
  })
  const observed = vi.fn()
  mock.control.faults.setFault({
    method: 'printer.objects.subscribe',
    fault: { type: 'delay', delayMs: 80 },
    count: 1,
  })
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey, origin: mock.origin },
    allowedOrigins: [mock.origin],
    limits: {
      maxMessageBytes: 65536,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 200,
      reconnectMaxMs: 400,
    },
    signal: controller.signal,
    linkHealth: health,
    onEvent: observed,
    onRawObservation: source.observe,
    onRawUnavailable: source.invalidate,
  })
  function reportedHealth() {
    const onComplete = vi.fn()
    const provider = source.open({
      binding: { agent_id: agentId } as Parameters<
        typeof source.open
      >[0]['binding'],
      assignmentRefs,
      deadlineMonoMs: performance.now() + 5000,
      signal: controller.signal,
      onComplete,
      onUnavailable() {},
    })
    provider.close()
    return onComplete.mock.lastCall?.[0].printers[0].linkHealth
  }
  try {
    await vi.waitFor(() => {
      expect(reportedHealth()).toMatchObject({
        state: 'connected',
        p95Ms: expect.any(Number),
        reconnects: 0,
        lastErrorCode: null,
      })
      expect(reportedHealth().p95Ms).toBeGreaterThanOrEqual(70)
    })
    mock.control.faults.setFault({
      method: 'printer.objects.query',
      fault: { type: 'drop' },
      count: 1,
    })
    await vi.waitFor(
      () => {
        expect(reportedHealth()).toMatchObject({
          state: 'connected',
          reconnects: 1,
          lastErrorCode: expect.any(String),
        })
      },
      { timeout: 3000 },
    )
  } finally {
    controller.abort()
    source.close()
    await subscription.done
    await mock.close()
  }
})
