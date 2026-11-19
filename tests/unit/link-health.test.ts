// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createLinkHealthRegistry,
  encodeLinkHealthSnapshot,
  linkHealthWireBytes,
  LINK_HEALTH_FRAME_MAX_BYTES,
  LINK_HEALTH_MAX_PRINTERS,
  LINK_RECONNECT_WINDOW_MS,
  LINK_RTT_WINDOW_MS,
  probePrinterLink,
} from '../../packages/connector/src/runtime/link-health.ts'
import {
  createConnectorHeartbeat,
  encodeConnectorHeartbeat,
  HEARTBEAT_FRAME_MAX_BYTES,
  HEARTBEAT_INTERVAL_MS,
  heartbeatWireBytes,
} from '../../packages/connector/src/runtime/heartbeat.ts'
import {
  startMock,
  withNetworkGuard,
  getNetworkGuardStats,
  resetNetworkGuardStats,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/index.ts'

const openMocks: MoonrakerMockInstance[] = []

afterEach(async () => {
  while (openMocks.length > 0) {
    const mock = openMocks.pop()!
    await mock.close()
  }
  vi.useRealTimers()
})

async function moonraker() {
  const mock = await startMock('moonraker')
  openMocks.push(mock)
  return mock
}

describe('link health registry', () => {
  test('tracks RTT p50/p95 over the last 60 s and reconnects in the last hour', () => {
    let now = 1_000_000
    const links = createLinkHealthRegistry({ now: () => now })
    links.ensure('printer-a')
    // Ten samples: 10, 20, … 100 ms → p50 = 50, p95 = 100 (nearest-rank).
    for (let i = 1; i <= 10; i++) {
      links.recordSuccess('printer-a', i * 10, now)
      now += 1_000
    }
    const mid = links.snapshot(now)
    expect(mid.printers).toHaveLength(1)
    expect(mid.printers[0]).toMatchObject({
      printerKey: 'printer-a',
      link: 'connected',
      rttP50Ms: 50,
      rttP95Ms: 100,
      reconnectsLastHour: 0,
    })
    expect(mid.printers[0]!.lastSuccessAt).toBe(now - 1_000)

    // Age the early samples out of the 60 s window; keep the last five.
    now += LINK_RTT_WINDOW_MS
    links.recordSuccess('printer-a', 200, now)
    const aged = links.snapshot(now)
    expect(aged.printers[0]!.rttP50Ms).toBe(200)
    expect(aged.printers[0]!.rttP95Ms).toBe(200)

    links.recordFailure('printer-a', 'drop', now)
    expect(links.snapshot(now).printers[0]).toMatchObject({
      link: 'reconnecting',
      lastErrorCode: 'drop',
    })
    links.recordReconnect('printer-a', now + 1)
    expect(links.snapshot(now + 1).printers[0]!.reconnectsLastHour).toBe(1)
    // Recovery from reconnecting to connected counts one more reconnect.
    links.recordSuccess('printer-a', 15, now + 2)
    const afterReconnect = links.snapshot(now + 2)
    expect(afterReconnect.printers[0]!.reconnectsLastHour).toBe(2)
    expect(afterReconnect.printers[0]!.link).toBe('connected')

    // Hour-old reconnects drop out of the window.
    now = now + 2 + LINK_RECONNECT_WINDOW_MS + 1
    expect(links.snapshot(now).printers[0]!.reconnectsLastHour).toBe(0)
    links.close()
  })

  test('snapshot for 100 printers stays within the link-health frame limit', () => {
    const links = createLinkHealthRegistry()
    for (let i = 0; i < LINK_HEALTH_MAX_PRINTERS; i++) {
      const key = `p${String(i).padStart(3, '0')}`
      links.recordSuccess(key, 5 + (i % 20), 1_700_000_000_000 + i)
      if (i % 7 === 0) links.recordFailure(key, 'drop', 1_700_000_000_050 + i)
      if (i % 11 === 0) links.recordReconnect(key, 1_700_000_000_100 + i)
    }
    const snapshot = links.snapshot(1_700_000_000_200)
    expect(snapshot.printers).toHaveLength(100)
    const bytes = linkHealthWireBytes(snapshot)
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(LINK_HEALTH_FRAME_MAX_BYTES)
    expect(() => encodeLinkHealthSnapshot(snapshot)).not.toThrow()
    links.close()
  })
})

describe('connector heartbeat', () => {
  test('exposes version, uptime, queue backlog, storage, rtc scope and printers', () => {
    let now = 10_000
    const links = createLinkHealthRegistry({ now: () => now })
    links.recordSuccess('sv06', 12, now)
    const beat = createConnectorHeartbeat({
      links,
      startedAt: 0,
      now: () => now,
      queueBacklog: () => 3,
      storage: () => 'degraded',
      rtcScope: () => 'lan',
      connectorVersion: '0.0.1-test',
      protocolRevision: 1,
    })
    now = 70_000
    const snapshot = beat.snapshot()
    expect(snapshot).toMatchObject({
      t: 'connector-heartbeat',
      connectorVersion: '0.0.1-test',
      protocolRevision: 1,
      uptimeMs: 70_000,
      queueBacklog: 3,
      storage: 'degraded',
      rtcScope: 'lan',
    })
    expect(snapshot.printers[0]).toMatchObject({
      printerKey: 'sv06',
      link: 'connected',
      rttP50Ms: 12,
    })
    const status = beat.statusSnapshot()
    expect(status.uptimeMs).toBe(70_000)
    expect(status.queueBacklog).toBe(3)
    expect(status.storage).toBe('degraded')
    expect(status.rtcScope).toBe('lan')
    expect(status.printers).toEqual(snapshot.printers)
    const wire = beat.encode()
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(
      HEARTBEAT_FRAME_MAX_BYTES,
    )
    expect(heartbeatWireBytes(snapshot)).toBe(Buffer.byteLength(wire, 'utf8'))
    beat.close()
    links.close()
  })

  test('emits a bounded telemetry heartbeat on the 60 s interval', async () => {
    vi.useFakeTimers()
    let now = 0
    const links = createLinkHealthRegistry({ now: () => now })
    links.recordSuccess('u1', 8, now)
    const emitted: string[] = []
    const beat = createConnectorHeartbeat({
      links,
      startedAt: 0,
      now: () => now,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      onHeartbeat: (_heartbeat, wire) => {
        emitted.push(wire)
      },
    })
    beat.start()
    expect(emitted).toHaveLength(0)
    now = HEARTBEAT_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(emitted).toHaveLength(1)
    expect(JSON.parse(emitted[0]!)).toMatchObject({
      t: 'connector-heartbeat',
      uptimeMs: HEARTBEAT_INTERVAL_MS,
    })
    expect(Buffer.byteLength(emitted[0]!, 'utf8')).toBeLessThanOrEqual(
      HEARTBEAT_FRAME_MAX_BYTES,
    )
    beat.stop()
    now = HEARTBEAT_INTERVAL_MS * 2
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(emitted).toHaveLength(1)
    beat.close()
    links.close()
  })

  test('heartbeat for 100 printers stays within the frame limit', () => {
    const links = createLinkHealthRegistry()
    for (let i = 0; i < 100; i++) {
      links.recordSuccess(`p${String(i).padStart(3, '0')}`, 15, 1_000 + i)
    }
    const beat = createConnectorHeartbeat({
      links,
      startedAt: 0,
      now: () => 50_000,
      queueBacklog: () => 0,
      storage: () => 'ok',
      rtcScope: () => 'loopback',
      connectorVersion: '0.0.1',
    })
    const snapshot = beat.snapshot()
    expect(snapshot.printers).toHaveLength(100)
    expect(heartbeatWireBytes(snapshot)).toBeLessThanOrEqual(
      HEARTBEAT_FRAME_MAX_BYTES,
    )
    expect(() => encodeConnectorHeartbeat(snapshot)).not.toThrow()
    beat.close()
    links.close()
  })
})

describe('mock delay and drop fault hooks', () => {
  test('injected delay raises RTT percentiles; drops mark offline/reconnecting with last error', async () => {
    await withNetworkGuard(async () => {
      resetNetworkGuardStats()
      const mock = await moonraker()
      expect(mock.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      const links = createLinkHealthRegistry()
      // Baseline without faults.
      for (let i = 0; i < 5; i++) {
        const result = await probePrinterLink({
          registry: links,
          printerKey: 'sv06',
          origin: mock.origin,
        })
        expect(result.ok).toBe(true)
      }
      const baseline = links.snapshot().printers[0]!
      expect(baseline.link).toBe('connected')
      expect(baseline.rttP50Ms).toBeDefined()
      expect(baseline.rttP95Ms).toBeDefined()
      expect(baseline.lastSuccessAt).toBeDefined()
      const baselineP50 = baseline.rttP50Ms!

      // Fresh key so the 60 s window holds only delayed samples.
      mock.control.faults.setFault({ type: 'delay', delayMs: 80 })
      const delayed: number[] = []
      for (let i = 0; i < 5; i++) {
        const result = await probePrinterLink({
          registry: links,
          printerKey: 'sv06-delayed',
          origin: mock.origin,
        })
        expect(result.ok).toBe(true)
        delayed.push(result.rttMs)
      }
      const withDelay = links
        .snapshot()
        .printers.find((p) => p.printerKey === 'sv06-delayed')!
      expect(withDelay.rttP50Ms!).toBeGreaterThanOrEqual(60)
      expect(withDelay.rttP50Ms!).toBeGreaterThan(baselineP50)
      expect(withDelay.rttP95Ms!).toBeGreaterThanOrEqual(withDelay.rttP50Ms!)
      expect(Math.min(...delayed)).toBeGreaterThanOrEqual(50)

      mock.control.faults.setFault({ type: 'drop' })
      const dropped = await probePrinterLink({
        registry: links,
        printerKey: 'sv06',
        origin: mock.origin,
      })
      expect(dropped.ok).toBe(false)
      expect(dropped.errorCode).toBeTruthy()
      const afterDrop = links.snapshot().printers[0]!
      expect(afterDrop.link).toBe('reconnecting')
      expect(afterDrop.lastErrorCode).toBe(dropped.errorCode)

      // Further failures while reconnecting keep the last error; offline after
      // an explicit offline transition when never connected is covered below.
      mock.control.faults.clearFaults()
      const recovered = await probePrinterLink({
        registry: links,
        printerKey: 'sv06',
        origin: mock.origin,
      })
      expect(recovered.ok).toBe(true)
      const afterRecover = links.snapshot().printers[0]!
      expect(afterRecover.link).toBe('connected')
      expect(afterRecover.reconnectsLastHour).toBeGreaterThanOrEqual(1)
      expect(afterRecover.lastErrorCode).toBeUndefined()

      const cold = createLinkHealthRegistry()
      mock.control.faults.setFault({ type: 'drop' })
      await probePrinterLink({
        registry: cold,
        printerKey: 'new-printer',
        origin: mock.origin,
      })
      expect(cold.snapshot().printers[0]).toMatchObject({
        printerKey: 'new-printer',
        link: 'offline',
        lastErrorCode: expect.any(String),
      })

      const guard = getNetworkGuardStats()
      expect(guard.rejectedAttempts).toBe(0)
      expect(guard.listenAttempts).toBeGreaterThan(0)
      cold.close()
      links.close()
    })
  })
})
