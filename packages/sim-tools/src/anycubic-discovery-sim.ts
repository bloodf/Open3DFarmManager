// SPDX-License-Identifier: MIT
// Simulator responses are made up from docs/protocols/anycubic-discovery.md.
import dgram from 'node:dgram'
import http from 'node:http'
import { FaultController } from './mocks/faults.ts'
import { startHttpMock } from './mocks/http-mock.ts'
import { ScenarioController, type ScenarioStep } from './mocks/scenario.ts'

export interface AnycubicDiscoveryInfo {
  ctrlType: string
  token: string
  ctrlInfoUrl: string
  modelId: string
  cn: string
  modelName: string
  deviceType: string
}

const DEFAULT_INFO: AnycubicDiscoveryInfo = {
  ctrlType: 'lan',
  token: 'simulator-token',
  ctrlInfoUrl: '/ctrl',
  modelId: 'K3',
  cn: 'simulator',
  modelName: 'Anycubic Kobra 3',
  deviceType: 'fdm',
}

export function anycubicDiscoveryMdnsResponse(): Buffer {
  const label = (s: string) =>
    Buffer.concat([
      ...s
        .split('.')
        .map((x) => Buffer.concat([Buffer.from([x.length]), Buffer.from(x)])),
      Buffer.from([0]),
    ])
  const name = label('_services._dns-sd._udp.local')
  const target = label('_test._tcp.local')
  const header = Buffer.alloc(10)
  header.writeUInt16BE(12)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(target.length, 8)
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
    name,
    header,
    target,
  ])
}

export function createAnycubicDiscoverySimulator(
  overrides: Partial<AnycubicDiscoveryInfo> = {},
) {
  let info: AnycubicDiscoveryInfo = { ...DEFAULT_INFO, ...overrides }
  const faults = new FaultController()
  const scenario = new ScenarioController<AnycubicDiscoveryInfo>({
    applyState: (patch) => {
      info = { ...info, ...patch }
    },
    publishReport: () => {},
    getState: () => ({ ...info }),
  })
  const server = http.createServer(async (request, response) => {
    const fault = faults.matchFault({
      path: (request.url ?? '/').split('?')[0],
      method: request.method ?? 'GET',
      headers: request.headers,
    })
    if (fault) {
      if (fault.type === 'drop') {
        request.socket.destroy()
        return
      }
      if (fault.type === 'refuse') {
        response.writeHead(fault.statusCode ?? 503).end(fault.message ?? '')
        return
      }
      if (fault.type === 'malformed') {
        response.setHeader('content-type', 'application/json')
        response.end(fault.payload ? fault.payload.toString() : '{malformed')
        return
      }
      if (fault.type === 'delay') {
        await new Promise((r) => setTimeout(r, fault.delayMs))
      }
      if (fault.type === 'stall') {
        return
      }
    }

    if (request.method !== 'GET' || request.url !== '/info') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(info))
  })
  return Object.assign(server, {
    control: {
      faults,
      scenario,
      setInfo: (patch: Partial<AnycubicDiscoveryInfo>) => {
        info = { ...info, ...patch }
      },
      getInfo: () => ({ ...info }),
    },
  })
}

export interface AnycubicDiscoverySimulatorOptions {
  port?: number | undefined
  mdns?: boolean | undefined
  info?: Partial<AnycubicDiscoveryInfo> | undefined
  scenario?: ScenarioStep<Record<string, unknown>>[] | undefined
}

export async function startAnycubicDiscoverySimulator(
  options: AnycubicDiscoverySimulatorOptions = {},
) {
  let info: AnycubicDiscoveryInfo = { ...DEFAULT_INFO, ...options.info }
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
    const packet = anycubicDiscoveryMdnsResponse()
    udp = dgram.createSocket('udp4')
    udp.on('error', () => {})
    udp.on('message', (_msg, peer) => {
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
          udp?.send(bad, peer.port, peer.address)
          return
        }
        if (mdnsFault.type === 'delay') {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer)
            if (!closed) udp?.send(packet, peer.port, peer.address)
          }, mdnsFault.delayMs)
          pendingTimers.add(timer)
          return
        }
      }
      udp?.send(packet, peer.port, peer.address)
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
      setInfo: (patch: Partial<AnycubicDiscoveryInfo>) => {
        info = { ...info, ...patch }
        httpMock.control.setState(info as unknown as Record<string, unknown>)
      },
      getInfo: () =>
        httpMock.control.getState() as unknown as AnycubicDiscoveryInfo,
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
