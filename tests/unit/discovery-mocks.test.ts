import { afterEach, describe, expect, test } from 'vitest'
import dgram from 'node:dgram'
import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'
import {
  getNetworkGuardStats,
  isMulticastAddress,
  resetNetworkGuardStats,
  startDiscoveryMocks,
  withNetworkGuard,
  type DiscoveryMockInstance,
} from '../../packages/sim-tools/src/mocks/index.ts'

const openMocks: DiscoveryMockInstance[] = []

afterEach(async () => {
  while (openMocks.length) {
    const mock = openMocks.pop()
    await mock?.close()
  }
  resetNetworkGuardStats()
})

async function startGuarded(
  ...args: Parameters<typeof startDiscoveryMocks>
): Promise<DiscoveryMockInstance> {
  const mock = await startDiscoveryMocks(...args)
  openMocks.push(mock)
  return mock
}

describe('discovery mocks on loopback (#413)', () => {
  test('rejects multicast destinations under the network guard', async () => {
    await withNetworkGuard(async () => {
      resetNetworkGuardStats()
      expect(isMulticastAddress('224.0.0.251')).toBe(true)
      expect(isMulticastAddress('239.255.255.250')).toBe(true)
      expect(isMulticastAddress('127.0.0.1')).toBe(false)

      const socket = dgram.createSocket('udp4')
      socket.on('error', () => {})
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(0, '127.0.0.1', () => {
          socket.removeListener('error', reject)
          resolve()
        })
      })
      try {
        await new Promise<void>((resolve, reject) => {
          socket.send(Buffer.from('probe'), 5353, '224.0.0.251', (error) => {
            if (error) resolve()
            else reject(new Error('multicast send should be rejected'))
          })
        })
        expect(() => socket.addMembership('224.0.0.251')).toThrow(
          /multicast membership rejected/,
        )
        const stats = getNetworkGuardStats()
        expect(stats.multicastRejected).toBeGreaterThanOrEqual(2)
        expect(stats.rejectedAttempts).toBe(0)
      } finally {
        await new Promise<void>((resolve) => socket.close(() => resolve()))
      }
    })
  })

  test('discovers every vendor with outbound network blocked', async () => {
    await withNetworkGuard(async () => {
      resetNetworkGuardStats()
      const mocks = await startGuarded({
        moonraker: { name: 'farm-a', port: 7125 },
        bambu: {
          serial: 'UNITBAMBU',
          model: 'X1C',
          name: 'Bambu Unit',
        },
        creality: { info: { model: 'K1', mac: 'AA:BB:CC:DD:EE:01' } },
        anycubic: {
          info: {
            modelId: 'K3',
            cn: 'any-serial',
            modelName: 'Kobra 3',
          },
        },
        kobraX: { deviceName: 'Kobra X Unit' },
      })

      for (const port of Object.values(mocks.ports)) {
        expect(port).toBeGreaterThan(0)
      }

      const before = getNetworkGuardStats()
      expect(before.rejectedAttempts).toBe(0)
      expect(before.multicastRejected).toBe(0)

      const foundPromise = discoverPrinters({
        ...mocks.discoveryOptions,
        timeout: 200,
      })

      await new Promise((resolve) => setTimeout(resolve, 40))
      mocks.announceBambu()

      const found = await foundPromise
      const byVendor = Object.fromEntries(
        found.map((printer) => [printer.vendor, printer]),
      )

      expect(byVendor.moonraker).toMatchObject({
        vendor: 'moonraker',
        host: '127.0.0.1',
        port: 7125,
        name: 'farm-a',
      })
      expect(byVendor.bambu).toMatchObject({
        vendor: 'bambu',
        host: '127.0.0.1',
        serial: 'UNITBAMBU',
        model: 'X1C',
        name: 'Bambu Unit',
      })
      expect(byVendor.creality).toMatchObject({
        vendor: 'creality',
        host: '127.0.0.1',
        model: 'K1',
        serial: 'AA:BB:CC:DD:EE:01',
      })
      expect(byVendor.anycubic).toMatchObject({
        vendor: 'anycubic',
        host: '127.0.0.1',
        serial: 'any-serial',
        model: 'K3',
        name: 'Kobra 3',
      })
      expect(byVendor['kobra-x']).toMatchObject({
        vendor: 'kobra-x',
        host: '127.0.0.1',
        port: 18910,
        model: 'Anycubic Kobra X',
        name: 'Kobra X Unit',
      })

      const after = getNetworkGuardStats()
      expect(after.rejectedAttempts).toBe(0)
      expect(after.multicastRejected).toBe(0)
      expect(after.listenAttempts).toBeGreaterThan(0)
    })
  })

  test('accepts an injected mDNS socket bound on loopback', async () => {
    await withNetworkGuard(async () => {
      const injected = dgram.createSocket('udp4')
      injected.on('error', () => {})
      await new Promise<void>((resolve, reject) => {
        injected.once('error', reject)
        injected.bind(0, '127.0.0.1', () => {
          injected.removeListener('error', reject)
          resolve()
        })
      })
      const boundPort = injected.address().port

      const mocks = await startGuarded({
        vendors: ['moonraker'],
        mdnsSocket: injected,
        moonraker: { name: 'injected', port: 7120 },
      })
      expect(mocks.ports.mdns).toBe(boundPort)

      const found = await discoverPrinters({
        ...mocks.discoveryOptions,
        timeout: 120,
      })
      expect(found).toEqual([
        {
          vendor: 'moonraker',
          host: '127.0.0.1',
          port: 7120,
          name: 'injected',
        },
      ])
      expect(getNetworkGuardStats().multicastRejected).toBe(0)
    })
  })
})
