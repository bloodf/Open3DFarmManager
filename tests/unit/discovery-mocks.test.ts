import dgram from 'node:dgram'
import net from 'node:net'
import { expect, test, vi } from 'vitest'
import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'
import { startAnycubicDiscoverySimulator } from '../../packages/sim-tools/src/anycubic-discovery-sim.ts'
import { startCrealityDiscoverySimulator } from '../../packages/sim-tools/src/creality-discovery-sim.ts'
import { startDiscoveryResponder } from '../../packages/sim-tools/src/mocks/discovery/index.ts'
import { startKobraXMock } from '../../packages/sim-tools/src/mocks/kobra-x-mock.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'

const loopback = '127.0.0.1'

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

test('blocks outbound TCP, UDP and multicast before sending traffic', () => {
  const rejected = guardOutbound()
  try {
    const socket = dgram.createSocket('udp4')
    expect(() => socket.send('query', 5353, '224.0.0.251')).toThrow(
      'Outbound network blocked',
    )
    expect(() => socket.addMembership('224.0.0.251')).toThrow(
      'Outbound network blocked',
    )
    expect(() => new net.Socket().connect(80, '192.0.2.1')).toThrow(
      'Outbound network blocked',
    )
    expect(rejected).toEqual(['224.0.0.251', '224.0.0.251', '192.0.2.1'])
    socket.close()
  } finally {
    vi.restoreAllMocks()
  }
})

test('discovers five printer vendors using guarded loopback sockets', async () => {
  const rejected = guardOutbound()
  try {
    await withNetworkGuard(async () => {
      const resources: { close: () => Promise<void> }[] = []
      async function own<T extends (typeof resources)[number]>(
        resource: Promise<T>,
      ) {
        const started = await resource
        resources.push(started)
        return started
      }

      try {
        const moonraker = await own(startMoonrakerMock({ port: 0 }))
        const moonrakerPort = Number(new URL(moonraker.origin).port)
        const responder = await own(startDiscoveryResponder(moonrakerPort))
        const creality = await own(startCrealityDiscoverySimulator({ port: 0 }))
        const anycubic = await own(startAnycubicDiscoverySimulator({ port: 0 }))
        const kobra = await own(startKobraXMock({ ssdp: true, camera: false }))
        if (kobra.ssdpPort === undefined)
          throw new Error('Missing Kobra X SSDP port')

        let bambuSocket: dgram.Socket | undefined
        const printers = await discoverPrinters({
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
            ssdpPort: kobra.ssdpPort,
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
        expect(printers).toHaveLength(5)
        expect(printers).toEqual(
          expect.arrayContaining([
            {
              vendor: 'bambu',
              host: loopback,
              serial: 'synthetic-bambu',
              model: 'BL-P001',
              name: 'Mock Bambu',
            },
            {
              vendor: 'moonraker',
              host: loopback,
              port: moonrakerPort,
              name: 'mock-printer',
            },
            {
              vendor: 'creality',
              host: loopback,
              serial: 'AA:BB:CC:00:00:01',
              model: 'Creality K1',
            },
            {
              vendor: 'anycubic',
              host: loopback,
              port: anycubic.port,
              serial: 'simulator',
              model: 'K3',
              name: 'Anycubic Kobra 3',
            },
            {
              vendor: 'kobra-x',
              host: loopback,
              port: 18910,
              model: 'Anycubic Kobra X',
              name: 'Anycubic Kobra X (Synthetic)',
            },
          ]),
        )
        expect(kobra.calls.ssdp).toEqual([
          expect.objectContaining({
            st: 'ac:3dprinter:20030',
            address: loopback,
          }),
        ])
      } finally {
        const closed = await Promise.allSettled(
          resources.map((resource) => resource.close()),
        )
        expect(closed.every((result) => result.status === 'fulfilled')).toBe(
          true,
        )
      }
    })
    expect(rejected).toEqual([])
  } finally {
    vi.restoreAllMocks()
  }
})
