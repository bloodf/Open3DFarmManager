import dgram from 'node:dgram'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { startAnycubicDiscoverySimulator } from '../../packages/sim-tools/src/anycubic-discovery-sim.ts'
import { startCrealityDiscoverySimulator } from '../../packages/sim-tools/src/creality-discovery-sim.ts'
import { startDiscoveryResponder } from '../../packages/sim-tools/src/mocks/discovery/index.ts'
import { startKobraXMock } from '../../packages/sim-tools/src/mocks/kobra-x-mock.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import {
  discoverPrinters,
  type Printer,
} from '../../packages/connector/src/discovery/index.ts'
import {
  discoveryBindings,
  runBackgroundDiscovery,
  startDiscoveryScan,
} from '../../packages/connector/src/runtime/background-discovery.ts'
import { scanConfigurationDiscovery } from '../../packages/connector/src/runtime/configuration-discovery.ts'
import type { ConfigurationAuthority } from '../../packages/connector/src/runtime/configuration-authority.ts'
import {
  parseBoundedJson,
  TelemetryBatch,
  type DiscoveryResults,
} from '@open3dfarmmanager/farm-protocol'

const loopback = '127.0.0.1'
const tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function guardOutbound() {
  const rejected: unknown[] = []
  function reject(destination: unknown): never {
    rejected.push(destination)
    throw new Error(`Outbound network blocked: ${String(destination)}`)
  }

  const send = dgram.Socket.prototype.send
  vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(function (
    this: dgram.Socket,
    ...args: unknown[]
  ) {
    const destination = typeof args[3] === 'number' ? args[4] : args[2]
    if (destination !== loopback) reject(destination)
    return Reflect.apply(send, this, args)
  })
  vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(() =>
    reject('connected UDP'),
  )
  vi.spyOn(dgram.Socket.prototype, 'addMembership').mockImplementation(
    (group) => reject(group),
  )
  const connect = net.Socket.prototype.connect
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    const host =
      first && typeof first === 'object' && 'host' in first
        ? first.host
        : typeof first === 'number'
          ? args[1]
          : undefined
    if (host !== loopback) reject(host)
    return Reflect.apply(connect, this, args)
  })
  return rejected
}

test('reports bounded, deduplicated observations with adoption and timestamps', () =>
  withNetworkGuard(async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const printer = {
      vendor: 'bambu',
      host: loopback,
      port: 8883,
      serial: 'serial-1',
      model: 'P1',
      name: 'Printer',
    } as const
    const local = {
      vendor: 'moonraker',
      host: loopback,
      port: 7125,
    } as const
    const scan = vi.fn(async (): Promise<Printer[]> => [
      { ...printer, accessCode: 'private' } as Printer,
      { ...printer, host: '127.0.0.2' },
      { ...printer, serial: 'other-bambu', host: '127.0.0.3' },
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
    expect(results[1]).toMatchObject({
      vendor: 'bambu',
      serial: 'other-bambu',
      host: '127.0.0.3',
      adopted: false,
    })
    expect(results[2]).toEqual({
      ...local,
      model: null,
      name: null,
      adopted: true,
      firstSeen: 100,
      lastSeen: 200,
    })
    expect(results[3]).toMatchObject({ serial: 'other-0', adopted: false })
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

test('skips background tick when a configuration scan is active and recovers after errors', () =>
  withNetworkGuard(async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const configPending = Promise.withResolvers<Printer[]>()
    const configScan = scanConfigurationDiscovery(
      {} as ConfigurationAuthority,
      randomUUID(),
      () => configPending.promise,
    )
    let calls = 0
    const bgScan = vi.fn(async (): Promise<Printer[]> => {
      calls++
      if (calls === 1) throw new Error('transient discovery failure')
      return [{ vendor: 'moonraker', host: loopback, port: 7125 }]
    })
    const report = vi.fn()
    const done = runBackgroundDiscovery({
      enabled: true,
      intervalMs: 100,
      signal: controller.signal,
      bindings: [{ vendor: 'moonraker', host: loopback, port: 7125 }],
      scan: bgScan,
      report,
      now: () => 500,
    })

    // Tick at 100ms is skipped while configuration scan holds the shared slot.
    await vi.advanceTimersByTimeAsync(150)
    expect(bgScan).not.toHaveBeenCalled()
    configPending.resolve([])
    await expect(configScan).resolves.toMatchObject({ ok: true, printers: [] })

    // Tick at 200ms fails and releases the lock without reporting.
    await vi.advanceTimersByTimeAsync(100)
    expect(bgScan).toHaveBeenCalledTimes(1)
    expect(report).not.toHaveBeenCalled()

    // Tick at 300ms succeeds and reports.
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await done
    expect(bgScan).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[0]).toEqual([
      {
        vendor: 'moonraker',
        host: loopback,
        port: 7125,
        model: null,
        name: null,
        firstSeen: 500,
        lastSeen: 500,
        adopted: true,
      },
    ])
  }))

test('reads discovery config defaults and overrides from Connector runtime config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-discovery-cfg-'))
  tempDirs.push(dir)
  const credential = {
    agent_id: randomUUID(),
    farm_id: randomUUID(),
  }
  const writeConfig = (
    name: string,
    discovery?: Record<string, unknown>,
  ): string => {
    const path = join(dir, name)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        collection: {
          version: 1,
          allowedOrigins: [`http://${loopback}:7125`],
          printers: [
            { printerKey: 'voron', origin: `http://${loopback}:7125` },
          ],
        },
        assignments: [
          {
            assignment_id: randomUUID(),
            farm_id: credential.farm_id,
            agent_id: credential.agent_id,
            printer_key: 'voron',
            moonraker_origin: `http://${loopback}:7125`,
          },
        ],
        telemetry: {
          endpoint: 'https://farm.example.com/telemetry',
          audience: 'open3dfarm/connector',
        },
        ...(discovery !== undefined ? { discovery } : {}),
      }),
      { mode: 0o600 },
    )
    return path
  }

  expect(
    readAgentRuntimeConfig(writeConfig('default.json'), credential).discovery,
  ).toEqual({
    enabled: true,
    intervalMs: 600_000,
  })
  expect(
    readAgentRuntimeConfig(
      writeConfig('disabled.json', { enabled: false }),
      credential,
    ).discovery,
  ).toEqual({
    enabled: false,
    intervalMs: 600_000,
  })
  expect(
    readAgentRuntimeConfig(
      writeConfig('custom.json', { intervalMs: 30_000 }),
      credential,
    ).discovery,
  ).toEqual({
    enabled: true,
    intervalMs: 30_000,
  })
})

test('discovers E16 loopback mocks on port 0, marks adopted bindings, and persists discovery telemetry', async () => {
  const rejected = guardOutbound()
  await withNetworkGuard(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-discovery-e16-'))
    tempDirs.push(dir)
    const resources: { close: () => Promise<void> }[] = []
    async function own<T extends (typeof resources)[number]>(
      resource: Promise<T>,
    ) {
      const started = await resource
      resources.push(started)
      return started
    }

    try {
      const moonraker = await own(startMoonrakerMock())
      const moonrakerPort = Number(new URL(moonraker.origin).port)
      const responder = await own(startDiscoveryResponder(moonrakerPort))
      const creality = await own(startCrealityDiscoverySimulator({ port: 0 }))
      const anycubic = await own(startAnycubicDiscoverySimulator({ port: 0 }))
      const kobra = await own(startKobraXMock({ ssdp: true, camera: false }))
      if (kobra.ssdpPort === undefined)
        throw new Error('Missing Kobra X SSDP port')

      const queueDir = join(dir, 'telemetry')
      const queue = new TelemetryQueue(queueDir, 1000)
      const controller = new AbortController()
      let reported: DiscoveryResults | undefined

      const bindings = discoveryBindings({
        version: 1,
        allowedOrigins: [moonraker.origin],
        printers: [
          { printerKey: 'adopted-moonraker', origin: moonraker.origin },
        ],
        limits: {
          maxMessageBytes: 262144,
          connectTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          staleAfterMs: 30000,
          reconnectMinMs: 1000,
          reconnectMaxMs: 30000,
        },
      })

      await runBackgroundDiscovery({
        enabled: true,
        intervalMs: 10,
        signal: controller.signal,
        bindings,
        now: () => 2000,
        scan: () => {
          let bambuSocket: dgram.Socket | undefined
          return discoverPrinters({
            timeout: 250,
            bindAddress: loopback,
            mdnsPort: 0,
            bambuPorts: [0],
            queryPort: responder.port,
            queryAddress: loopback,
            crealityPorts: { http: creality.port, https: creality.port },
            anycubicPort: anycubic.port,
            kobraX: {
              target: loopback,
              ssdpPort: kobra.ssdpPort!,
              httpPort: kobra.httpPort,
            },
            createSocket: () => {
              const socket = dgram.createSocket('udp4')
              if (!bambuSocket) {
                bambuSocket = socket
                socket.once('listening', () =>
                  responder.notifyBambu(socket.address().port),
                )
              }
              return socket
            },
          })
        },
        report(results, now) {
          reported = results
          queue.enqueueDiscovery(results, now)
          controller.abort()
        },
      })

      expect(reported).toBeDefined()
      expect(reported).toHaveLength(5)
      expect(reported).toEqual(
        expect.arrayContaining([
          {
            vendor: 'moonraker',
            host: loopback,
            port: moonrakerPort,
            model: null,
            name: 'mock-printer',
            firstSeen: 2000,
            lastSeen: 2000,
            adopted: true,
          },
          {
            vendor: 'bambu',
            host: loopback,
            port: null,
            serial: 'synthetic-bambu',
            model: 'BL-P001',
            name: 'Mock Bambu',
            firstSeen: 2000,
            lastSeen: 2000,
            adopted: false,
          },
          {
            vendor: 'creality',
            host: loopback,
            port: null,
            serial: 'AA:BB:CC:00:00:01',
            model: 'Creality K1',
            name: null,
            firstSeen: 2000,
            lastSeen: 2000,
            adopted: false,
          },
          {
            vendor: 'anycubic',
            host: loopback,
            port: anycubic.port,
            serial: 'simulator',
            model: 'K3',
            name: 'Anycubic Kobra 3',
            firstSeen: 2000,
            lastSeen: 2000,
            adopted: false,
          },
          {
            vendor: 'kobra-x',
            host: loopback,
            port: 18910,
            model: 'Anycubic Kobra X',
            name: 'Anycubic Kobra X (Synthetic)',
            firstSeen: 2000,
            lastSeen: 2000,
            adopted: false,
          },
        ]),
      )
      expect(JSON.stringify(reported)).not.toContain('token')

      const batch = queue.batch(2000)
      expect(batch.records).toHaveLength(1)
      expect(batch.records[0]).toMatchObject({
        kind: 'discovery',
        queuedAt: 2000,
        discovery: reported,
      })
      queue.close()

      // Verify durable log canonical recovery for discovery events.
      const reopened = new TelemetryQueue(queueDir, 2000)
      try {
        expect(reopened.batch(2000).records).toEqual(batch.records)
      } finally {
        reopened.close()
      }
    } finally {
      const closed = await Promise.allSettled(
        resources.map((resource) => resource.close()),
      )
      expect(closed.every((result) => result.status === 'fulfilled')).toBe(true)
    }
  })
  expect(rejected).toEqual([])
})
