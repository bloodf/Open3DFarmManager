// SPDX-License-Identifier: MIT
// This simulator's responses are made up from docs/protocols/creality-discovery.md.
import dgram from 'node:dgram'
import { startHttpMock } from './mocks/http-mock.ts'
import type { ScenarioStep } from './mocks/scenario.ts'

export interface CrealityDiscoveryInfo {
  model: string
  mac: string
}

const DEFAULT_INFO: CrealityDiscoveryInfo = {
  model: 'Creality K1',
  mac: 'AA:BB:CC:00:00:01',
}

export function crealityDiscoveryResponse(): Buffer {
  const name = (value: string) =>
    Buffer.concat([
      ...value
        .split('.')
        .map((part) =>
          Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]),
        ),
      Buffer.from([0]),
    ])
  const target = name('_creality._tcp.local')
  const header = Buffer.alloc(10)
  header.writeUInt16BE(12)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(target.length, 8)
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
    name('_services._dns-sd._udp.local'),
    header,
    target,
  ])
}

export interface CrealityDiscoverySimulatorOptions {
  port?: number | undefined
  mdns?: boolean | undefined
  duplicateMdns?: boolean | undefined
  info?: Partial<CrealityDiscoveryInfo> | undefined
  scenario?: ScenarioStep<Record<string, unknown>>[] | undefined
}

export async function startCrealityDiscoverySimulator(
  options: CrealityDiscoverySimulatorOptions = {},
) {
  let info: CrealityDiscoveryInfo = { ...DEFAULT_INFO, ...options.info }
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  let closed = false

  let httpMockRef: Awaited<ReturnType<typeof startHttpMock>> | undefined

  const httpMock = await startHttpMock({
    port: options.port,
    scenario: options.scenario as ScenarioStep[] | undefined,
    initialState: info as unknown as Record<string, unknown>,
    handler: async (request, response) => {
      const path = (request.url ?? '/').split('?')[0]
      if (request.method !== 'GET' || path !== '/info') {
        response.writeHead(404).end()
        return
      }

      const ackFault = httpMockRef?.control.faults.matchFault({
        path,
        method: 'ACK',
      })
      if (ackFault) {
        if (ackFault.type === 'drop') {
          request.socket.destroy()
          return
        }
        if (ackFault.type === 'refuse') {
          response.writeHead(ackFault.statusCode ?? 401).end()
          return
        }
        if (ackFault.type === 'stall') {
          return
        }
        if (ackFault.type === 'malformed') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            ackFault.payload ? ackFault.payload.toString() : '{malformed',
          )
          return
        }
        if (ackFault.type === 'delay') {
          await new Promise((r) => setTimeout(r, ackFault.delayMs))
          if (closed) return
        }
      }

      const reportFault = httpMockRef?.control.faults.matchFault({
        path,
        method: 'REPORT',
      })
      if (reportFault) {
        if (reportFault.type === 'drop') {
          request.socket.destroy()
          return
        }
        if (reportFault.type === 'refuse') {
          response.writeHead(reportFault.statusCode ?? 401).end()
          return
        }
        if (reportFault.type === 'stall') {
          return
        }
        if (reportFault.type === 'malformed') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            reportFault.payload ? reportFault.payload.toString() : '{malformed',
          )
          return
        }
        if (reportFault.type === 'delay') {
          await new Promise((r) => setTimeout(r, reportFault.delayMs))
          if (closed) return
        }
      }

      const state = httpMockRef?.control.getState() ?? info
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(state))
    },
  })
  httpMockRef = httpMock

  let udp: dgram.Socket | undefined
  let udpPort: number | undefined
  if (options.mdns !== false) {
    const packet = crealityDiscoveryResponse()
    udp = dgram.createSocket('udp4')
    udp.on('error', () => {})
    udp.on('message', (_msg, peer) => {
      const sendReply = (buf: Buffer) => {
        udp?.send(buf, peer.port, peer.address)
        if (options.duplicateMdns) {
          udp?.send(buf, peer.port, peer.address)
        }
      }
      const mdnsFault = httpMock.control.faults.matchFault({
        path: '/mdns',
        method: 'MDNS',
      })
      if (mdnsFault) {
        if (
          mdnsFault.type === 'drop' ||
          mdnsFault.type === 'refuse' ||
          mdnsFault.type === 'stall'
        ) {
          return
        }
        if (mdnsFault.type === 'malformed') {
          const bad = mdnsFault.payload
            ? Buffer.isBuffer(mdnsFault.payload)
              ? mdnsFault.payload
              : Buffer.from(mdnsFault.payload)
            : Buffer.from('not-mdns')
          sendReply(bad)
          return
        }
        if (mdnsFault.type === 'delay') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer)
            if (!closed) sendReply(packet)
          }, mdnsFault.delayMs)
          pendingTimers.add(timer)
          return
        }
      }
      sendReply(packet)
    })
    await new Promise<void>((resolve, reject) => {
      udp!.once('error', reject)
      udp!.bind(0, '127.0.0.1', () => {
        udp!.removeListener('error', reject)
        resolve()
      })
    })
    udpPort = udp.address().port
  }

  let closing: Promise<void> | undefined

  return {
    host: '127.0.0.1',
    port: httpMock.ports.default,
    udpPort,
    origin: httpMock.origin,
    ports: httpMock.ports,
    control: {
      ...httpMock.control,
      setInfo: (patch: Partial<CrealityDiscoveryInfo>) => {
        info = { ...info, ...patch }
        httpMock.control.setState(info as unknown as Record<string, unknown>)
      },
      getInfo: () =>
        httpMock.control.getState() as unknown as CrealityDiscoveryInfo,
    },
    calls: httpMock.calls,
    close() {
      closed = true
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
      closing ??= (async () => {
        if (udp) {
          await new Promise<void>((resolve) => udp!.close(() => resolve()))
        }
        await httpMock.close()
      })()
      return closing
    },
  }
}
