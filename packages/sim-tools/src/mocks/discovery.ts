// SPDX-License-Identifier: MIT
/**
 * LAN discovery responders for loopback tests (E19.1 / #413).
 * Binds only 127.0.0.1 with ephemeral ports; never joins or sends multicast.
 */
import dgram from 'node:dgram'
import {
  anycubicDiscoveryMdnsResponse,
  startAnycubicDiscoverySimulator,
  type AnycubicDiscoverySimulatorOptions,
} from '../anycubic-discovery-sim.ts'
import {
  crealityDiscoveryResponse,
  startCrealityDiscoverySimulator,
  type CrealityDiscoverySimulatorOptions,
} from '../creality-discovery-sim.ts'
import { FaultController } from './faults.ts'
import { startHttpMock, type HttpMockInstance } from './http-mock.ts'
import { assertLoopbackAddress } from './network-guard.ts'

export type DiscoveryVendor =
  'moonraker' | 'bambu' | 'creality' | 'anycubic' | 'kobra-x'

const ALL_VENDORS: readonly DiscoveryVendor[] = [
  'moonraker',
  'bambu',
  'creality',
  'anycubic',
  'kobra-x',
]

const MOONRAKER_SERVICE = '_moonraker._tcp.local'

function dnsName(value: string): Buffer {
  return Buffer.concat([
    ...value
      .split('.')
      .map((part) =>
        Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]),
      ),
    Buffer.from([0]),
  ])
}

function dnsRecord(owner: string, type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(data.length, 8)
  return Buffer.concat([dnsName(owner), header, data])
}

export function moonrakerDiscoveryResponse(
  options: {
    name?: string | undefined
    host?: string | undefined
    port?: number | undefined
  } = {},
): Buffer {
  const instanceName = options.name ?? 'printer'
  const hostName = `${instanceName}.local`
  const servicePort = options.port ?? 7125
  const ipv4 = options.host ?? '127.0.0.1'
  const octets = ipv4.split('.').map((part) => Number(part))
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw new Error(`Invalid Moonraker discovery host: ${ipv4}`)
  }
  const instance = `${instanceName}.${MOONRAKER_SERVICE}`
  const srv = Buffer.concat([
    Buffer.from([0, 0, 0, 0, (servicePort >> 8) & 0xff, servicePort & 0xff]),
    dnsName(hostName),
  ])
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0]),
    dnsRecord(MOONRAKER_SERVICE, 12, dnsName(instance)),
    dnsRecord(instance, 33, srv),
    dnsRecord(instance, 16, Buffer.from([3, 120, 61, 49])),
    dnsRecord(hostName, 1, Buffer.from(octets)),
  ])
}

export function bambuSsdpNotify(
  options: {
    host?: string | undefined
    locationPort?: number | undefined
    serial?: string | undefined
    model?: string | undefined
    name?: string | undefined
  } = {},
): Buffer {
  const host = options.host ?? '127.0.0.1'
  const locationPort = options.locationPort ?? 2021
  const serial = options.serial ?? 'MOCKBAMBU01'
  const model = options.model ?? 'BL-P001'
  const name = options.name ?? 'Bambu Mock'
  return Buffer.from(
    [
      'NOTIFY * HTTP/1.1',
      `Location: http://${host}:${locationPort}/`,
      `USN: uuid:${serial}`,
      `DevModel.bambu.com: ${model}`,
      `DevName.bambu.com: ${name}`,
      'DevConnect.bambu.com: lan',
      'DevBind.bambu.com: free',
      '',
      '',
    ].join('\r\n'),
  )
}

const DEFAULT_KOBRA_TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'

export interface DiscoveryMockOptions {
  vendors?: readonly DiscoveryVendor[] | undefined
  /** Injected mDNS socket (must already be bound to loopback, or left unbound). */
  mdnsSocket?: dgram.Socket | undefined
  /** Injected SSDP socket for Kobra X (same binding rules as mdnsSocket). */
  kobraSsdpSocket?: dgram.Socket | undefined
  moonraker?:
    | {
        name?: string | undefined
        host?: string | undefined
        port?: number | undefined
      }
    | undefined
  bambu?:
    | {
        host?: string | undefined
        locationPort?: number | undefined
        serial?: string | undefined
        model?: string | undefined
        name?: string | undefined
        /** Ephemeral loopback port discovery should bind for NOTIFY. */
        listenPort?: number | undefined
      }
    | undefined
  creality?: CrealityDiscoverySimulatorOptions | undefined
  anycubic?: AnycubicDiscoverySimulatorOptions | undefined
  kobraX?:
    | {
        token?: string | undefined
        deviceName?: string | undefined
        ssdpPort?: number | undefined
        httpPort?: number | undefined
      }
    | undefined
}

export interface DiscoveryMockPorts {
  mdns?: number
  bambu?: number
  crealityHttp?: number
  anycubicHttp?: number
  kobraXSsdp?: number
  kobraXHttp?: number
}

export interface DiscoveryClientOptions {
  bindAddress: '127.0.0.1'
  queryAddress: '127.0.0.1'
  queryPort?: number
  mdnsPort: 0
  bambuPorts: number[]
  crealityPorts?: { https: number; http: number }
  anycubicPort?: number
  kobraX?: false | { target: string; ssdpPort: number; httpPort: number }
}

export interface DiscoveryMockInstance {
  host: '127.0.0.1'
  ports: DiscoveryMockPorts
  /** Pass through to `discoverPrinters` for loopback-only scans. */
  discoveryOptions: DiscoveryClientOptions
  control: {
    faults: FaultController
  }
  /** Push a Bambu SSDP NOTIFY to the reserved listen port (or an override). */
  announceBambu: (toPort?: number) => void
  close: () => Promise<void>
}

function enabledSet(
  vendors: readonly DiscoveryVendor[] | undefined,
): Set<DiscoveryVendor> {
  const list = vendors?.length ? vendors : ALL_VENDORS
  return new Set(list)
}

async function bindUdp(
  socket: dgram.Socket,
  port: number,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(port, host, () => {
      socket.removeListener('error', reject)
      resolve()
    })
  })
  const addr = socket.address()
  assertLoopbackAddress(addr)
  return typeof addr === 'string' ? port : addr.port
}

async function reserveLoopbackUdpPort(): Promise<number> {
  const socket = dgram.createSocket('udp4')
  socket.on('error', () => {})
  const port = await bindUdp(socket, 0, '127.0.0.1')
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

async function ensureBound(
  socket: dgram.Socket,
  port: number | undefined,
): Promise<number> {
  try {
    const existing = socket.address()
    if (existing && typeof existing !== 'string') {
      assertLoopbackAddress(existing)
      return existing.port
    }
  } catch {
    // not bound yet
  }
  return bindUdp(socket, port ?? 0, '127.0.0.1')
}

/**
 * Start in-process LAN discovery responders on 127.0.0.1 / port 0.
 * Creality and Anycubic HTTP(+optional) reuse their harness sims with `mdns: false`;
 * mDNS replies are served from one shared loopback socket. Kobra X SSDP matches
 * the empty-datagram behaviour from the Kobra X mock (#365).
 */
export async function startDiscoveryMocks(
  options: DiscoveryMockOptions = {},
): Promise<DiscoveryMockInstance> {
  const vendors = enabledSet(options.vendors)
  const faults = new FaultController()
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  let closed = false

  const needsMdns =
    vendors.has('moonraker') ||
    vendors.has('creality') ||
    vendors.has('anycubic')

  let mdnsSocket: dgram.Socket | undefined
  let ownsMdns = false
  let mdnsPort: number | undefined

  let crealitySim:
    Awaited<ReturnType<typeof startCrealityDiscoverySimulator>> | undefined
  let anycubicSim:
    Awaited<ReturnType<typeof startAnycubicDiscoverySimulator>> | undefined

  if (vendors.has('creality')) {
    crealitySim = await startCrealityDiscoverySimulator({
      ...options.creality,
      mdns: false,
    })
  }
  if (vendors.has('anycubic')) {
    anycubicSim = await startAnycubicDiscoverySimulator({
      ...options.anycubic,
      mdns: false,
    })
  }

  if (needsMdns) {
    mdnsSocket = options.mdnsSocket ?? dgram.createSocket('udp4')
    ownsMdns = !options.mdnsSocket
    mdnsSocket.on('error', () => {})

    const moonrakerPacket = vendors.has('moonraker')
      ? moonrakerDiscoveryResponse(options.moonraker)
      : undefined
    const crealityPacket = vendors.has('creality')
      ? crealityDiscoveryResponse()
      : undefined
    const anycubicPacket = vendors.has('anycubic')
      ? anycubicDiscoveryMdnsResponse()
      : undefined

    mdnsSocket.on('message', (_msg, peer) => {
      if (closed) return
      const replies = [moonrakerPacket, crealityPacket, anycubicPacket].filter(
        (packet): packet is Buffer => packet !== undefined,
      )
      const fault = faults.matchFault({ path: '/mdns', method: 'MDNS' })
      if (fault) {
        if (
          fault.type === 'drop' ||
          fault.type === 'refuse' ||
          fault.type === 'stall'
        ) {
          return
        }
        if (fault.type === 'malformed') {
          const bad = fault.payload
            ? Buffer.isBuffer(fault.payload)
              ? fault.payload
              : Buffer.from(fault.payload)
            : Buffer.from('not-mdns')
          mdnsSocket?.send(bad, peer.port, peer.address)
          return
        }
        if (fault.type === 'delay') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer)
            if (closed) return
            for (const packet of replies) {
              mdnsSocket?.send(packet, peer.port, peer.address)
            }
          }, fault.delayMs)
          pendingTimers.add(timer)
          return
        }
      }
      for (const packet of replies) {
        mdnsSocket?.send(packet, peer.port, peer.address)
      }
    })

    mdnsPort = await ensureBound(mdnsSocket, undefined)
  }

  let bambuPort: number | undefined
  let bambuAnnounce: dgram.Socket | undefined
  const bambuPacket = vendors.has('bambu')
    ? bambuSsdpNotify(options.bambu)
    : undefined

  if (vendors.has('bambu')) {
    bambuPort = options.bambu?.listenPort ?? (await reserveLoopbackUdpPort())
    bambuAnnounce = dgram.createSocket('udp4')
    bambuAnnounce.on('error', () => {})
    await bindUdp(bambuAnnounce, 0, '127.0.0.1')
  }

  let kobraHttp: HttpMockInstance | undefined
  let kobraSsdp: dgram.Socket | undefined
  let ownsKobraSsdp = false
  let kobraSsdpPort: number | undefined

  if (vendors.has('kobra-x')) {
    const token = options.kobraX?.token ?? DEFAULT_KOBRA_TOKEN
    const deviceName = options.kobraX?.deviceName ?? 'Anycubic Kobra X'
    kobraHttp = await startHttpMock({
      port: options.kobraX?.httpPort,
      faults,
      handler: (request, response) => {
        const path = (request.url ?? '/').split('?')[0]
        if (request.method !== 'GET' || path !== '/info') {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ctrlType: 'lan',
            modelId: '20030',
            token,
            deviceName,
          }),
        )
      },
    })

    kobraSsdp = options.kobraSsdpSocket ?? dgram.createSocket('udp4')
    ownsKobraSsdp = !options.kobraSsdpSocket
    kobraSsdp.on('error', () => {})
    // Mirror packages/sim-tools/src/mocks/kobra-x-mock.ts SSDP: empty datagram.
    kobraSsdp.on('message', (msg, rinfo) => {
      if (closed) return
      const text = msg.toString('utf8')
      const lines = text.split(/\r?\n/)
      const firstLine = (lines[0] ?? '').trim()
      if (!/^M-SEARCH\b/i.test(firstLine)) return
      let st = ''
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':')
        if (idx > 0 && line.slice(0, idx).trim().toUpperCase() === 'ST') {
          st = line.slice(idx + 1).trim()
          break
        }
      }
      if (
        st &&
        st !== 'ssdp:all' &&
        st !== 'upnp:rootdevice' &&
        !st.startsWith('ac:3dprinter:')
      ) {
        return
      }
      const fault = faults.matchFault({ path: '/ssdp', method: 'SSDP' })
      if (fault) {
        if (
          fault.type === 'drop' ||
          fault.type === 'refuse' ||
          fault.type === 'stall'
        ) {
          return
        }
        if (fault.type === 'malformed') {
          const bad = fault.payload
            ? Buffer.isBuffer(fault.payload)
              ? fault.payload
              : Buffer.from(fault.payload)
            : Buffer.from('HTTP/1.1 200 OK\r\nST: invalid\r\n\r\n')
          kobraSsdp?.send(bad, rinfo.port, rinfo.address)
          return
        }
        if (fault.type === 'delay') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer)
            if (!closed) {
              kobraSsdp?.send(Buffer.alloc(0), rinfo.port, rinfo.address)
            }
          }, fault.delayMs)
          pendingTimers.add(timer)
          return
        }
      }
      kobraSsdp?.send(Buffer.alloc(0), rinfo.port, rinfo.address)
    })
    kobraSsdpPort = await ensureBound(kobraSsdp, options.kobraX?.ssdpPort)
  }

  const ports: DiscoveryMockPorts = {
    ...(mdnsPort !== undefined ? { mdns: mdnsPort } : {}),
    ...(bambuPort !== undefined ? { bambu: bambuPort } : {}),
    ...(crealitySim ? { crealityHttp: crealitySim.port } : {}),
    ...(anycubicSim ? { anycubicHttp: anycubicSim.port } : {}),
    ...(kobraSsdpPort !== undefined ? { kobraXSsdp: kobraSsdpPort } : {}),
    ...(kobraHttp ? { kobraXHttp: kobraHttp.ports.default } : {}),
  }

  const discoveryOptions: DiscoveryClientOptions = {
    bindAddress: '127.0.0.1',
    queryAddress: '127.0.0.1',
    mdnsPort: 0,
    bambuPorts: bambuPort !== undefined ? [bambuPort] : [],
    ...(mdnsPort !== undefined ? { queryPort: mdnsPort } : {}),
    ...(crealitySim
      ? {
          crealityPorts: {
            https: crealitySim.port,
            http: crealitySim.port,
          },
        }
      : {}),
    ...(anycubicSim ? { anycubicPort: anycubicSim.port } : {}),
    ...(kobraSsdpPort !== undefined && kobraHttp
      ? {
          kobraX: {
            target: '127.0.0.1',
            ssdpPort: kobraSsdpPort,
            httpPort: kobraHttp.ports.default,
          },
        }
      : { kobraX: false }),
  }

  let closing: Promise<void> | undefined

  return {
    host: '127.0.0.1',
    ports,
    discoveryOptions,
    control: { faults },
    announceBambu(toPort) {
      if (!bambuPacket || !bambuAnnounce) {
        throw new Error('Bambu discovery mock is not enabled')
      }
      const target = toPort ?? bambuPort
      if (target === undefined) {
        throw new Error('Bambu listen port is missing')
      }
      bambuAnnounce.send(bambuPacket, target, '127.0.0.1')
    },
    close() {
      closed = true
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      closing ??= (async () => {
        const closeUdp = (socket: dgram.Socket | undefined, owns: boolean) =>
          new Promise<void>((resolve) => {
            if (!socket || !owns) {
              resolve()
              return
            }
            socket.close(() => resolve())
          })
        await Promise.all([
          closeUdp(mdnsSocket, ownsMdns),
          closeUdp(bambuAnnounce, true),
          closeUdp(kobraSsdp, ownsKobraSsdp),
          crealitySim?.close(),
          anycubicSim?.close(),
          kobraHttp?.close(),
        ])
      })()
      return closing
    },
  }
}
