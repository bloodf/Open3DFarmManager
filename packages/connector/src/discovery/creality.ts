import http from 'node:http'
import https from 'node:https'
import { isIPv4 } from 'node:net'
import type { Printer } from './index.ts'
import { readFileSync } from 'node:fs'

const secureHosts = new Set<string>()

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
  ca?: string,
  strict = false,
  rejectMetadata = secure,
  allowUnavailable = false,
): Promise<Printer | undefined> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (value?: Printer) => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    const request = (secure ? https : http).get(
      {
        hostname: host,
        port,
        path: '/info',
        timeout: 3000,
        ...(ca ? { ca } : {}),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          if (strict) {
            done = true
            reject(
              new Error(
                `Creality HTTPS discovery returned HTTP ${response.statusCode}`,
              ),
            )
          } else finish()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) {
            response.destroy()
            if (strict) {
              done = true
              reject(new Error('Creality HTTPS discovery response too large'))
            } else finish()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', () => {
          if (strict && !done) {
            done = true
            reject(new Error('Creality HTTPS discovery response failed'))
          } else finish()
        })
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
              rejectMetadata &&
              (!valid(data.model) ||
                !valid(data.mac) ||
                !validPort(data.wssPort) ||
                !validPort(data.videoPort))
            ) {
              done = true
              reject(
                new Error(
                  'Invalid Creality HTTPS endpoint metadata (model, mac, wssPort or videoPort)',
                ),
              )
              return
            }
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
                ...(secure
                  ? { port: Number(data.wssPort), transport: 'wss' as const }
                  : {}),
              })
            else finish()
          } catch {
            if (rejectMetadata) {
              done = true
              reject(
                new Error('Invalid Creality HTTPS endpoint metadata (JSON)'),
              )
            } else finish()
          }
        })
      },
    )
    request.on('timeout', () => {
      if (strict && !done) {
        done = true
        reject(new Error('Creality HTTPS discovery timed out'))
      }
      request.destroy()
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (
        !done &&
        strict &&
        !(
          allowUnavailable &&
          ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(
            error.code ?? '',
          )
        )
      ) {
        done = true
        reject(new Error(`Creality HTTPS discovery failed: ${error.message}`))
      } else finish()
    })
  })
}

export async function probeCreality(
  host: string,
  ports: { https: number; http: number; caFile?: string | undefined } = {
    https: 443,
    http: 80,
  },
): Promise<Printer | undefined> {
  if (!isIPv4(host)) return
  // An explicitly shared HTTP/HTTPS probe port denotes a legacy-only scan.
  if (
    ports.https === ports.http &&
    !ports.caFile &&
    !secureHosts.has(`${host}:${ports.https}`)
  )
    return probe(host, ports.http, false)
  const discovered = await probe(
    host,
    ports.https,
    true,
    ports.caFile ? readFileSync(ports.caFile, 'utf8') : undefined,
    true,
    true,
    !ports.caFile && !secureHosts.has(`${host}:${ports.https}`),
  )
  if (discovered) {
    secureHosts.add(`${host}:${ports.https}`)
    return discovered
  }
  return probe(host, ports.http, false)
}

/** Resolve once before opening a socket. Invalid secure metadata never downgrades. */
export async function resolveCrealityEndpoint(input: {
  host: string
  port?: number | undefined
  httpsPort?: number | undefined
  caFile?: string | undefined
}) {
  const ca = input.caFile ? readFileSync(input.caFile, 'utf8') : undefined
  const discovered = await probe(
    input.host,
    input.httpsPort ?? 443,
    true,
    ca,
    true,
    true,
    !input.caFile &&
      !secureHosts.has(`${input.host}:${input.httpsPort ?? 443}`) &&
      input.port !== undefined,
  )
  if (discovered) secureHosts.add(`${input.host}:${input.httpsPort ?? 443}`)
  return {
    host: input.host,
    port: discovered?.port ?? input.port ?? 9999,
    secure: discovered?.transport === 'wss',
    ca,
  }
}
