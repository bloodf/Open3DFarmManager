import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

/** Reconstruct only the original request target and ordered raw headers. */
export function signallingFixtureUpgradeWire(input: {
  method: string
  target: string
  version: string
  rawHeaders: readonly string[]
}): string {
  if (
    !/^[A-Z]+$/.test(input.method) ||
    !input.target.startsWith('/') ||
    /[\r\n]/.test(input.target) ||
    Buffer.byteLength(input.target) > 8192 ||
    !/^1\.[01]$/.test(input.version) ||
    input.rawHeaders.length > 128 ||
    input.rawHeaders.length % 2 !== 0
  )
    throw new Error('Invalid fixture upgrade metadata')
  const lines = [`${input.method} ${input.target} HTTP/${input.version}`]
  for (let index = 0; index < input.rawHeaders.length; index += 2) {
    const name = input.rawHeaders[index],
      value = input.rawHeaders[index + 1]
    if (
      !name ||
      value === undefined ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      /[\r\n]/.test(value)
    )
      throw new Error('Invalid fixture upgrade headers')
    lines.push(`${name}: ${value}`)
  }
  const wire = lines.join('\r\n') + '\r\n\r\n'
  if (Buffer.byteLength(wire) > 32768)
    throw new Error('Fixture upgrade headers too large')
  return wire
}

export async function disconnectFixtureUpgrades(upgrades: ReadonlySet<Duplex>) {
  const active = [...upgrades]
  if (!active.length) throw new Error('No active fixture upgrades')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(
        active.map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once('close', resolve)
              socket.destroy()
            }),
        ),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture upgrade close timeout')),
          3000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Fixture-only TLS forwarder. Nitro owns the upstream upgrade listener. */
export function signallingHttpsProxy(input: {
  key: Buffer
  cert: Buffer
  upstreamPort: number
}) {
  if (
    !Number.isInteger(input.upstreamPort) ||
    input.upstreamPort < 1024 ||
    input.upstreamPort > 65535
  )
    throw new Error('Invalid fixture upstream port')
  const server = createHttpsServer(
    { key: input.key, cert: input.cert },
    (req, res) => {
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: input.upstreamPort,
          method: req.method,
          path: req.url,
          headers: req.rawHeaders,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.rawHeaders)
          reply.pipe(res)
        },
      )
      upstream.setTimeout(10_000, () =>
        upstream.destroy(new Error('Fixture upstream timeout')),
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
    },
  )
  const clients = new Set<Duplex>()
  const upgrades = new Set<Duplex>()
  server.on('connection', (socket) => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    upgrades.add(socket)
    socket.once('close', () => upgrades.delete(socket))
    if (
      !req.url ||
      req.rawHeaders.length > 128 ||
      Buffer.byteLength(req.url) > 8192
    ) {
      socket.destroy()
      return
    }
    let wire: string
    try {
      wire = signallingFixtureUpgradeWire({
        method: req.method ?? '',
        target: req.url,
        version: req.httpVersion,
        rawHeaders: req.rawHeaders,
      })
    } catch {
      socket.destroy()
      return
    }
    const upstream = connect({ host: '127.0.0.1', port: input.upstreamPort })
    req.socket.setTimeout(35_000, () => socket.destroy())
    upstream.setTimeout(35_000, () => upstream.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
    upstream.once('connect', () => {
      upstream.write(wire)
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
  })
  return {
    server,
    disconnectUpgrades: () => disconnectFixtureUpgrades(upgrades),
    async close() {
      if (!server.listening) return
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      for (const socket of clients) socket.destroy()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          stopped,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Fixture proxy close timeout')),
              3000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
