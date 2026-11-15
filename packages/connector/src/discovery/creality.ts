import http from 'node:http'
import https from 'node:https'
import { isIPv4 } from 'node:net'
import type { Printer } from './index.ts'

const service = '_services._dns-sd._udp.local'
export function crealityQuery(): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...service
      .split('.')
      .map((part) =>
        Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]),
      ),
    Buffer.from([0, 0, 12, 0x80, 1]),
  ])
}

export function isCrealityResponse(
  packet: Buffer,
  records: { type: number; value: string }[],
): boolean {
  return (
    packet.length >= 12 &&
    packet.readUInt16BE(0) === 0 &&
    packet.readUInt16BE(2) === 0x8400 &&
    records.some((r) => r.type === 12 && /creality|cxswbox/i.test(r.value))
  )
}

function probe(
  host: string,
  port: number,
  secure: boolean,
): Promise<Printer | undefined> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value?: Printer) => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    const request = (secure ? https : http).get(
      { hostname: host, port, path: '/info', timeout: 3000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) {
            response.destroy()
            finish()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', () => finish())
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const valid = (x: unknown) =>
              typeof x === 'string' &&
              x.length > 0 &&
              x.length <= 128 &&
              /^[\x20-\x7e]+$/.test(x)
            const validPort = (x: unknown) =>
              (typeof x === 'number' ||
                (typeof x === 'string' && /^\d+$/.test(x))) &&
              Number.isInteger(Number(x)) &&
              Number(x) >= 1 &&
              Number(x) <= 65535
            if (
              valid(data.model) &&
              valid(data.mac) &&
              (!secure ||
                (validPort(data.wssPort) && validPort(data.videoPort)))
            )
              finish({
                vendor: 'creality',
                host,
                model: data.model,
                serial: data.mac,
              })
            else finish()
          } catch {
            finish()
          }
        })
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => finish())
  })
}

export async function probeCreality(
  host: string,
  ports: { https: number; http: number } = { https: 443, http: 80 },
): Promise<Printer | undefined> {
  if (!isIPv4(host)) return
  return (
    (await probe(host, ports.https, true)) ??
    (await probe(host, ports.http, false))
  )
}
