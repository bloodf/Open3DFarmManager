import { request } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

export type PrinterProbe = {
  vendor: 'moonraker' | 'creality' | 'bambu' | 'anycubic'
  host: string
  port: number
  hint?: string
}

function httpProbe(
  host: string,
  port: number,
  timeout: number,
  websocket: boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (result: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.destroy()
      resolve(result)
    }
    const key = randomBytes(16).toString('base64')
    const req = request(
      {
        host,
        port,
        path: websocket ? '/' : '/server/info',
        method: 'GET',
        headers: websocket
          ? {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Key': key,
            }
          : {},
      },
      (res) => {
        if (websocket || res.statusCode !== 200) {
          res.resume()
          finish(false)
          return
        }
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
          if (body.length > 65536) finish(false)
        })
        res.on('end', () => {
          try {
            const data: unknown = JSON.parse(body)
            finish(
              typeof data === 'object' &&
                data !== null &&
                'result' in data &&
                typeof data.result === 'object' &&
                data.result !== null &&
                'moonraker_version' in data.result &&
                typeof data.result.moonraker_version === 'string',
            )
          } catch {
            finish(false)
          }
        })
        res.on('error', () => finish(false))
      },
    )
    req.on('upgrade', (res, socket) => {
      const expected = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      const valid =
        websocket &&
        res.statusCode === 101 &&
        res.headers['sec-websocket-accept'] === expected
      socket.destroy()
      finish(valid)
    })
    req.on('error', () => finish(false))
    const timer = setTimeout(() => finish(false), timeout)
    req.end()
  })
}

function tlsProbe(
  host: string,
  port: number,
  timeout: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const socket = tlsConnect({
      host,
      port,
      rejectUnauthorized: false,
      ...(isIP(host) ? {} : { servername: host }),
    })
    const finish = (result: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish(false), timeout)
    socket.once('secureConnect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
  })
}

export async function probePrinterHost(
  host: string,
  options: { timeoutMs?: number; ports?: Record<number, number> } = {},
): Promise<PrinterProbe | undefined> {
  const timeout = options.timeoutMs ?? 3000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3000)
    throw new Error('invalid timeout')
  if (
    !host ||
    host.length > 253 ||
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
  )
    throw new Error('invalid host')
  const defaults: PrinterProbe[] = [
    ...[7125, 80, ...Array.from({ length: 15 }, (_, i) => 7126 + i)].map(
      (port): PrinterProbe => ({
        vendor: 'moonraker',
        host,
        port,
        ...(port >= 7126 ? { hint: 'may be a KobraLink bridge' } : {}),
      }),
    ),
    { vendor: 'creality', host, port: 9999 },
    { vendor: 'bambu', host, port: 8883 },
    { vendor: 'anycubic', host, port: 9883 },
  ]
  const candidates =
    options.ports === undefined
      ? defaults
      : defaults
          .filter((candidate) => options.ports?.[candidate.port] !== undefined)
          .map((candidate) => ({
            ...candidate,
            port: options.ports![candidate.port]!,
          }))
  const matches = await Promise.all(
    candidates.map((candidate) =>
      candidate.vendor === 'moonraker'
        ? httpProbe(host, candidate.port, timeout, false)
        : candidate.vendor === 'creality'
          ? httpProbe(host, candidate.port, timeout, true)
          : tlsProbe(host, candidate.port, timeout),
    ),
  )
  return candidates.find((_, index) => matches[index])
}
