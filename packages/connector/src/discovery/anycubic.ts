import http from 'node:http'
import { isIPv4 } from 'node:net'
import type { Printer } from './index.ts'

export function probeAnycubic(
  host: string,
  port = 18910,
): Promise<Printer | undefined> {
  if (!isIPv4(host)) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: host, port, path: '/info', timeout: 1000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(undefined)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) response.destroy()
          else chunks.push(chunk)
        })
        response.on('error', () => resolve(undefined))
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const valid = (v: unknown): v is string =>
              typeof v === 'string' &&
              v.length > 0 &&
              v.length <= 128 &&
              /^[\x20-\x7e]+$/.test(v)
            if (
              data.ctrlType !== 'cloud' &&
              valid(data.ctrlType) &&
              valid(data.token) &&
              valid(data.ctrlInfoUrl) &&
              valid(data.modelId) &&
              valid(data.cn) &&
              valid(data.modelName) &&
              valid(data.deviceType)
            ) {
              resolve({
                vendor: 'anycubic',
                host,
                port,
                serial: data.cn,
                model: data.modelId,
                name: data.modelName,
              })
            } else resolve(undefined)
          } catch {
            resolve(undefined)
          }
        })
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(undefined))
  })
}
