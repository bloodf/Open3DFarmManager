import { afterEach, expect, test, vi } from 'vitest'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import {
  runBackgroundDiscovery,
  startDiscoveryScan,
} from '../../packages/connector/src/runtime/background-discovery.ts'
import type { Printer } from '../../packages/connector/src/discovery/index.ts'
import {
  parseBoundedJson,
  TelemetryBatch,
} from '@open3dfarmmanager/farm-protocol'

afterEach(() => vi.useRealTimers())

test('reports bounded, deduplicated observations with adoption and timestamps', () =>
  withNetworkGuard(async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const printer = {
      vendor: 'bambu',
      host: '127.0.0.1',
      port: 8883,
      serial: 'serial-1',
      model: 'P1',
      name: 'Printer',
    } as const
    const local = {
      vendor: 'moonraker',
      host: '127.0.0.1',
      port: 7125,
    } as const
    const scan = vi.fn(async (): Promise<Printer[]> => [
      { ...printer, accessCode: 'private' } as Printer,
      { ...printer, host: '127.0.0.2' },
      local,
      { ...local, port: 7126 },
      ...Array.from({ length: 70 }, (_, index) => ({
        ...printer,
        serial: `other-${index}`,
      })),
    ])
    const report = vi.fn()
    const done = runBackgroundDiscovery({
      enabled: true,
      intervalMs: 100,
      signal: controller.signal,
      bindings: [{ ...printer, host: '127.0.0.3' }, local],
      scan,
      report,
      now: () => scan.mock.calls.length * 100,
    })
    await vi.advanceTimersByTimeAsync(200)
    controller.abort()
    await done
    const [results] = report.mock.calls[1]!
    expect(results).toHaveLength(64)
    expect(results[0]).toEqual({
      ...printer,
      adopted: true,
      firstSeen: 100,
      lastSeen: 200,
    })
    expect(results[1]).toEqual({
      ...local,
      model: null,
      name: null,
      adopted: true,
      firstSeen: 100,
      lastSeen: 200,
    })
    expect(results[2]).toMatchObject({ serial: 'other-0', adopted: false })
    const record = {
      eventId: '11111111-1111-4111-8111-111111111111',
      queuedAt: 200,
      kind: 'discovery',
      discovery: results,
    }
    expect(
      TelemetryBatch.parse(
        parseBoundedJson(JSON.stringify([record]), {
          maxBytes: 65536,
          maxDepth: 7,
          maxValues: 2000,
          maxStringChars: 128,
        }),
      ),
    ).toEqual([record])
  }))

test('disabled discovery never scans or reports', async () => {
  const scan = vi.fn()
  const report = vi.fn()
  await runBackgroundDiscovery({
    enabled: false,
    intervalMs: 100,
    signal: new AbortController().signal,
    bindings: [],
    scan,
    report,
  })
  expect(scan).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

test('holds the shared scan slot until an in-flight scan settles', () =>
  withNetworkGuard(async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = Promise.withResolvers<Printer[]>()
    const scan = vi.fn(() => pending.promise)
    const report = vi.fn()
    const done = runBackgroundDiscovery({
      enabled: true,
      intervalMs: 100,
      signal: controller.signal,
      bindings: [],
      scan,
      report,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(startDiscoveryScan(scan)).toBeUndefined()
    controller.abort()
    pending.resolve([])
    await done
    expect(report).not.toHaveBeenCalled()
    await expect(startDiscoveryScan(scan)).resolves.toEqual([])
  }))
