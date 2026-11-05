import test from 'node:test'
import assert from 'node:assert/strict'
import { IncomingMessage, createServer, request } from 'node:http'
import { Socket } from 'node:net'
import { createRequire } from 'node:module'
import { realpathSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_ATTRIBUTES,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import {
  installSignallingWebSocketBounds,
  installSignallingControlBounds,
  inspectSignallingUpgrade,
  signallingBrowserSession,
  SIGNALLING_NATIVE_MAX_PAYLOAD,
  SIGNALLING_SUBPROTOCOL,
  PAUSE_SIGNALLING_SUBPROTOCOL,
} from '../../apps/farm/server/services/signalling-websocket-boundary.ts'

// Resolve the dependencies ACTUALLY selected by the installed Nuxt Nitro builder.
const nuxtRequire = createRequire(
  realpathSync(
    new URL('../../apps/farm/node_modules/nuxt/package.json', import.meta.url),
  ),
)
const builderRequire = createRequire(nuxtRequire.resolve('@nuxt/nitro-server'))
const nitroRequire = createRequire(
  builderRequire.resolve('nitropack/package.json'),
)
assert.equal(
  JSON.parse(
    readFileSync(builderRequire.resolve('nitropack/package.json'), 'utf8'),
  ).version,
  '2.13.6',
)
assert.equal(
  JSON.parse(
    readFileSync(
      join(
        dirname(nitroRequire.resolve('crossws/adapters/node')),
        '../../package.json',
      ),
      'utf8',
    ),
  ).version,
  '0.3.5',
)
const { createApp, defineWebSocketHandler, toNodeListener } = await import(
  join(dirname(nitroRequire.resolve('h3')), 'index.mjs')
)
const { default: nodeAdapter } = await import(
  nitroRequire.resolve('crossws/adapters/node')
)
const origin = 'https://farm.example'
const cookie = {
  name: SESSION_COOKIE_NAME,
  password: 'independent-synthetic-session-secret-123456789',
  maxAge: 3600,
  cookie: { ...SESSION_COOKIE_ATTRIBUTES },
}
test('pause upgrade requires its exact path and subprotocol and preserves browser cookie checks', async () => {
  for (const role of ['browser', 'connector'] as const) {
    const value = input(role)
    value._req.url = '/api/signalling/pause-' + role
    const at = value._req.rawHeaders.indexOf(SIGNALLING_SUBPROTOCOL)
    assert.ok(at >= 0)
    assert.throws(() => inspectSignallingUpgrade(value, role, origin, 'pause'))
    value._req.rawHeaders[at] = PAUSE_SIGNALLING_SUBPROTOCOL
    assert.doesNotThrow(() =>
      inspectSignallingUpgrade(value, role, origin, 'pause'),
    )
    assert.throws(() => inspectSignallingUpgrade(value, role, origin))
    value._req.url += '?mode=read-only'
    assert.throws(() => inspectSignallingUpgrade(value, role, origin, 'pause'))
    value._req.socket.destroy()
  }
})
function input(role = 'browser', extra: string[] = []) {
  const raw = new IncomingMessage(new Socket())
  raw.method = 'GET'
  raw.url = '/api/signalling/' + role
  raw.rawHeaders = [
    'Host',
    'farm.example',
    'Upgrade',
    'websocket',
    'Connection',
    'Upgrade',
    'Sec-WebSocket-Version',
    '13',
    'Sec-WebSocket-Key',
    randomBytes(16).toString('base64'),
    'Sec-WebSocket-Protocol',
    SIGNALLING_SUBPROTOCOL,
    ...(role === 'browser'
      ? [
          'Origin',
          origin,
          'Cookie',
          '__Host-open3dfarmmanager-session=synthetic',
        ]
      : []),
    ...extra,
  ]
  return { _req: raw }
}
async function sealedCookie() {
  const event = { req: new Request(origin), res: { headers: new Headers() } }
  const session = await useSession(event, cookie)
  await session.update({ sessionRecordId: 'own_login_session_text' })
  const sealed = event.res.headers.getSetCookie().at(-1)?.split(';')[0]
  assert.ok(sealed)
  return sealed
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture deadline exceeded')),
          3000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('native limits are installed in the actual H3 cached options before adapter construction', () => {
  const app = createApp()
  installSignallingWebSocketBounds(app)
  assert.equal(
    app.websocket.serverOptions.maxPayload,
    SIGNALLING_NATIVE_MAX_PAYLOAD,
  )
  assert.equal(app.websocket.serverOptions.perMessageDeflate, false)
  assert.equal(app.websocket.serverOptions.autoPong, false)
  assert.equal(Object.isFrozen(app.websocket), true)
  const cached = createApp()
  void cached.websocket
  assert.throws(
    () => installSignallingWebSocketBounds(cached),
    /before adapter/,
  )
  const preconstructed = createApp({ websocket: { wss: {} } })
  assert.throws(
    () => installSignallingWebSocketBounds(preconstructed),
    /Preconstructed/,
  )
  assert.throws(() => installSignallingWebSocketBounds({}), /Unsupported/)
})
test('global upgrade boundary rejects unmanaged paths and missing or failed route admission without a listener catcher', async () => {
  const app = createApp()
  let opened = 0
  app.use('/ordinary', () => 'ordinary HTTP')
  app.use(
    '/api/signalling/browser',
    defineWebSocketHandler({
      upgrade() {
        throw new Error('Runtime unavailable')
      },
      open() {
        opened++
      },
    }),
  )
  // A route without its admission hook must never become a permissive socket.
  app.use(
    '/api/signalling/connector',
    defineWebSocketHandler({
      open() {
        opened++
      },
    }),
  )
  installSignallingWebSocketBounds(app)
  const adapter = nodeAdapter(app.websocket)
  const server = createServer(toNodeListener(app))
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  // Same uncaught upgrade binding as Nitro's generated Node listener.
  server.on('upgrade', adapter.handleUpgrade)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    for (const [path, expected] of [
      ['/unknown', 404],
      ['/ordinary', 404],
      ['/api/signalling/browser?token=synthetic', 404],
      ['/api/signalling/browser/', 404],
      ['/api/signalling/browser', 403],
      ['/api/signalling/connector', 503],
    ] as const) {
      const req = request({
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      })
      try {
        const response = deadline(
          new Promise<number | undefined>((resolve, reject) => {
            req.once('response', (res) => {
              res.resume()
              res.once('end', () => resolve(res.statusCode))
            })
            req.once('upgrade', (_res, socket) => {
              socket.destroy()
              reject(new Error('Unexpected upgrade'))
            })
            req.once('error', reject)
          }),
        )
        req.end()
        assert.equal(await response, expected)
      } finally {
        req.destroy()
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(opened, 0)
    assert.equal(adapter.peers.size, 0)
    assert.equal(sockets.size, 0)
  } finally {
    adapter.closeAll(1000, undefined, true)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
test('strict original upgrade boundary separates sealed browser credentials from machines', async () => {
  assert.equal(
    inspectSignallingUpgrade(input(), 'browser', origin).origin,
    origin,
  )
  assert.equal(
    inspectSignallingUpgrade(input('connector'), 'connector', origin).origin,
    origin,
  )
  for (const extra of [
    ['Origin', origin],
    ['Cookie', 'x=y'],
    ['Sec-Fetch-Site', 'same-origin'],
    ['Authorization', 'Bearer secret'],
  ])
    assert.throws(() =>
      inspectSignallingUpgrade(input('connector', extra), 'connector', origin),
    )
  for (const extra of [
    ['Origin', origin],
    ['Cookie', 'other=x'],
    ['Authorization', 'Bearer secret'],
    ['Content-Length', '1'],
    ['X-Test', 'x'.repeat(16384)],
  ])
    assert.throws(() =>
      inspectSignallingUpgrade(input('browser', extra), 'browser', origin),
    )
  for (const url of [
    '/api/signalling/browser?token=secret',
    '/api/signalling/%62rowser',
    '//api/signalling/browser',
  ]) {
    const value = input()
    value._req.url = url
    assert.throws(() => inspectSignallingUpgrade(value, 'browser', origin))
  }
  const cross = input()
  cross._req.rawHeaders[cross._req.rawHeaders.indexOf('Origin') + 1] =
    'https://other.example'
  assert.throws(() => inspectSignallingUpgrade(cross, 'browser', origin))
  const protocol = input()
  protocol._req.rawHeaders[
    protocol._req.rawHeaders.indexOf('Sec-WebSocket-Protocol') + 1
  ] = SIGNALLING_SUBPROTOCOL + ',secret'
  assert.throws(() => inspectSignallingUpgrade(protocol, 'browser', origin))
  assert.throws(
    () =>
      inspectSignallingUpgrade(
        { url: origin, headers: new Headers() },
        'browser',
        origin,
      ),
    /Unsupported/,
  )
  const valid = input()
  valid._req.rawHeaders[valid._req.rawHeaders.indexOf('Cookie') + 1] =
    await sealedCookie()
  assert.equal(
    (await signallingBrowserSession(valid, origin, cookie)).sessionRecordId,
    'own_login_session_text',
  )
  const tampered = input()
  tampered._req.rawHeaders[tampered._req.rawHeaders.indexOf('Cookie') + 1] =
    '__Host-open3dfarmmanager-session=tampered'
  await assert.rejects(signallingBrowserSession(tampered, origin, cookie))
  valid._req.socket.destroy()
  cross._req.socket.destroy()
  protocol._req.socket.destroy()
  tampered._req.socket.destroy()
})

test('actual pinned Node adapter rejects oversized messages before application callbacks and disables compression', async () => {
  let configuredOrigin = '',
    delivered = 0,
    upgradeFailure = ''
  const app = createApp()
  app.use(
    '/api/signalling/connector',
    defineWebSocketHandler({
      upgrade(value: unknown) {
        try {
          inspectSignallingUpgrade(value, 'connector', configuredOrigin)
        } catch (error) {
          upgradeFailure = error instanceof Error ? error.message : 'unknown'
          throw error
        }
      },
      message() {
        delivered++
      },
    }),
  )
  installSignallingWebSocketBounds(app)
  const adapter = nodeAdapter(app.websocket)
  const server = createServer(toNodeListener(app))
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    void adapter.handleUpgrade(req, socket, head).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  configuredOrigin = `https://127.0.0.1:${address.port}`
  const client = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/signalling/connector`,
    SIGNALLING_SUBPROTOCOL,
  )
  client.addEventListener('error', () => {})
  try {
    await deadline(
      new Promise<void>((resolve, reject) => {
        client.addEventListener('open', () => resolve(), { once: true })
        client.addEventListener(
          'close',
          () => reject(new Error('Upgrade rejected: ' + upgradeFailure)),
          { once: true },
        )
      }),
    )
    assert.equal(client.extensions, '')
    const closed = new Promise<number>((resolve) =>
      client.addEventListener('close', (event) => resolve(event.code), {
        once: true,
      }),
    )
    client.send('x'.repeat(SIGNALLING_NATIVE_MAX_PAYLOAD + 1))
    assert.equal(await deadline(closed), 1009)
    assert.equal(delivered, 0)
  } finally {
    client.close()
    adapter.closeAll(1000, undefined, true)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('actual upgrade hook unseals the maintained cookie without executing an ordinary HTTP handler', async () => {
  const sealed = await sealedCookie()
  let configuredOrigin = '',
    sessionId = '',
    httpCalls = 0
  const app = createApp()
  app.use(
    '/api/signalling/browser',
    defineWebSocketHandler({
      upgrade: async (value: unknown) => {
        sessionId = (
          await signallingBrowserSession(value, configuredOrigin, cookie)
        ).sessionRecordId
      },
      open(peer: { close(code: number): void }) {
        peer.close(1000)
      },
    }),
  )
  app.use(() => {
    httpCalls++
    return 'ordinary-http'
  })
  installSignallingWebSocketBounds(app)
  const adapter = nodeAdapter(app.websocket),
    server = createServer(toNodeListener(app))
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    void adapter.handleUpgrade(req, socket, head).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  configuredOrigin = `https://127.0.0.1:${address.port}`
  const req = request({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/signalling/browser',
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      Origin: configuredOrigin,
      Cookie: sealed,
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol': SIGNALLING_SUBPROTOCOL,
    },
  })
  try {
    const status = deadline(
      new Promise<number>((resolve, reject) => {
        req.once('upgrade', (res, socket) => {
          socket.destroy()
          resolve(res.statusCode ?? 0)
        })
        req.once('response', (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.once('error', reject)
      }),
    )
    req.end()
    assert.equal(await status, 101)
    assert.equal(sessionId, 'own_login_session_text')
    assert.equal(httpCalls, 0)
  } finally {
    req.destroy()
    adapter.closeAll(1000, undefined, true)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('native masked ping burst terminates without automatic pong buffering', async () => {
  const app = createApp()
  let delivered = 0
  app.use(
    '/api/signalling/connector',
    defineWebSocketHandler({
      upgrade() {},
      open(peer: unknown) {
        installSignallingControlBounds(peer)
      },
      message() {
        delivered++
      },
    }),
  )
  installSignallingWebSocketBounds(app)
  const adapter = nodeAdapter(app.websocket)
  const server = createServer(toNodeListener(app))
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    void adapter.handleUpgrade(req, socket, head).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const req = request({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/signalling/connector',
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    },
  })
  let client: Socket | undefined
  try {
    const upgraded = deadline(
      new Promise<{ socket: Socket; head: Buffer }>((resolve, reject) => {
        req.once('upgrade', (_response, socket, head) =>
          resolve({ socket, head }),
        )
        req.once('error', reject)
        req.once('response', () => reject(new Error('Upgrade rejected')))
      }),
    )
    req.end()
    const result = await upgraded
    client = result.socket
    let received = result.head.length
    client.on('data', (chunk) => {
      received += chunk.length
    })
    const closed = deadline(
      new Promise<void>((resolve) => client!.once('close', () => resolve())),
    )
    client.on('error', () => {})
    // Legal masked pings; the first must terminate, with no control output queued.
    const ping = Buffer.concat([
      Buffer.from([0x89, 0xfd]),
      Buffer.alloc(4),
      Buffer.alloc(125),
    ])
    client.write(Buffer.concat(Array.from({ length: 512 }, () => ping)))
    await closed
    assert.equal(received, 0)
    assert.equal(delivered, 0)
  } finally {
    req.destroy()
    client?.destroy()
    adapter.closeAll(1000, undefined, true)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
