import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { signallingFixtureUpgradeWire } from '../helpers/signalling-https-proxy.ts'

test('fixture forwards exact raw target, Host and duplicate header order', () => {
  const wire = signallingFixtureUpgradeWire({
    method: 'GET',
    target: '/api/signalling/connector?x=%2f',
    version: '1.1',
    rawHeaders: [
      'Host',
      '127.0.0.1:4444',
      'Origin',
      'https://one.example',
      'origin',
      'https://two.example',
      'X-Empty',
      '',
    ],
  })
  assert.equal(
    wire,
    'GET /api/signalling/connector?x=%2f HTTP/1.1\r\nHost: 127.0.0.1:4444\r\nOrigin: https://one.example\r\norigin: https://two.example\r\nX-Empty: \r\n\r\n',
  )
})
test('fixture rejects malformed or unbounded upgrade metadata', () => {
  const valid = {
    method: 'GET',
    target: '/x',
    version: '1.1',
    rawHeaders: ['Host', 'localhost'],
  }
  for (const bad of [
    { ...valid, target: '/x\r\nInjected: x' },
    { ...valid, rawHeaders: ['X', 'ok\r\nInjected: x'] },
    { ...valid, rawHeaders: ['X'] },
    { ...valid, rawHeaders: ['X', 'x'.repeat(33000)] },
  ])
    assert.throws(() => signallingFixtureUpgradeWire(bad))
})

test('TLS proxy forwards raw upgrade bytes over the actual loopback socket', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { createServer } = await import('node:net')
  const { connect } = await import('node:tls')
  const { signallingHttpsProxy } =
    await import('../helpers/signalling-https-proxy.ts')
  const directory = await mkdtemp(join(tmpdir(), 'signalling-proxy-test-'))
  let proxy: ReturnType<typeof signallingHttpsProxy> | undefined
  const upstream = createServer()
  const sockets = new Set<import('node:net').Socket>()
  upstream.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(directory, 'key'),
        '-out',
        join(directory, 'cert'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore', timeout: 10000 },
    )
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const upstreamAddress = upstream.address()
    assert(upstreamAddress && typeof upstreamAddress !== 'string')
    proxy = signallingHttpsProxy({
      key: await readFile(join(directory, 'key')),
      cert: await readFile(join(directory, 'cert')),
      upstreamPort: upstreamAddress.port,
    })
    proxy.server.listen(0, '127.0.0.1')
    await once(proxy.server, 'listening')
    const address = proxy.server.address()
    assert(address && typeof address !== 'string')
    const expected =
      'GET /api/signalling/connector?x=%2f HTTP/1.1\r\nHost: one.example\r\nHost: two.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Test: first\r\nx-test: second\r\n\r\nPAYLOAD'
    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('upstream timed out')),
        3000,
      )
      upstream.once('connection', (socket) => {
        let bytes = ''
        socket.on('data', (chunk) => {
          bytes += chunk.toString('latin1')
          if (bytes.includes('\r\n\r\nPAYLOAD')) {
            clearTimeout(timer)
            resolve(bytes)
            socket.end(
              'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
            )
          }
        })
      })
    })
    const client = connect({
      host: '127.0.0.1',
      port: address.port,
      ca: await readFile(join(directory, 'cert')),
      servername: 'localhost',
    })
    try {
      await once(client, 'secureConnect')
      let response = ''
      client.on('data', (chunk: Buffer) => {
        response += chunk.toString('latin1')
      })
      const ended = once(client, 'end')
      client.write(expected)
      assert.equal(await received, expected)
      await Promise.race([
        ended,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('response timed out')), 3000),
        ),
      ])
      assert.equal(
        response,
        'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      )
    } finally {
      client.destroy()
    }
  } finally {
    await proxy?.close()
    for (const socket of sockets) socket.destroy()
    if (upstream.listening)
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      )
    await rm(directory, { recursive: true, force: true })
  }
})
