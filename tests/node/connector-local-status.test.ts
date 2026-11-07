import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import {
  openLocalStatus,
  parseStatusPort,
  projectStatus,
} from '../../packages/connector/src/status/local.ts'

async function availablePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
function read(
  port: number,
  path = '/status',
  headers: Record<string, string> = {},
  method = 'GET',
) {
  return new Promise<{ code: number | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path, method, headers },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (part) => {
            body += part
          })
          res.on('end', () => resolve({ code: res.statusCode, body }))
        },
      )
      req.on('error', reject)
      req.end()
    },
  )
}
test('status configuration and projection reject unsafe values and omit secrets', () => {
  for (const value of [
    '0',
    '-1',
    '65536',
    '1e3',
    ' 8080',
    'localhost:8080',
    '08080',
  ])
    assert.throws(() => parseStatusPort(value))
  assert.equal(parseStatusPort('8080'), 8080)
  const privateState = {
    queueDepth: 2,
    delivered: 3,
    retries: 1,
    credentialExpired: false,
    token: 'secret',
    path: '/private',
  }
  assert.deepEqual(projectStatus(privateState), {
    queueDepth: 2,
    delivered: 3,
    retries: 1,
    credentialExpired: false,
  })
  assert.equal(
    projectStatus({ ...privateState, queueDepth: NaN }).queueDepth,
    0,
  )
})
test('loopback status enforces authority, origin and read-only routes; closes active sockets', async () => {
  const port = await availablePort()
  let depth = 2
  const server = await openLocalStatus({
    port,
    read: () => ({
      queueDepth: depth,
      delivered: 3,
      retries: 1,
      credentialExpired: false,
    }),
    onError: () => {},
  })
  try {
    assert.equal((await read(port)).code, 200)
    depth = 5
    assert.equal(JSON.parse((await read(port)).body).queueDepth, 5)
    const page = await read(port, '/')
    assert.match(page.body, /lang="pt-BR"/)
    assert.match(page.body, /<dd>5<\/dd>/)
    for (const host of [
      'evil.example',
      `localhost:${port}`,
      `[::1]:${port}`,
      `127.0.0.1:${port + 1}`,
    ])
      assert.equal((await read(port, '/status', { Host: host })).code, 403)
    for (const origin of [
      'null',
      'https://evil.example',
      `http://127.0.0.1:${port + 1}`,
    ])
      assert.equal((await read(port, '/status', { Origin: origin })).code, 403)
    assert.equal(
      (await read(port, '/status', { 'Sec-Fetch-Site': 'cross-site' })).code,
      403,
    )
    assert.equal((await read(port, '/status', {}, 'POST')).code, 405)
    assert.equal((await read(port, '/command')).code, 404)
  } finally {
    await server.close()
  }
  await assert.rejects(read(port))
})
test('occupied port rejects startup without taking over existing listener', async () => {
  const port = await availablePort()
  const input = {
    port,
    read: () => ({
      queueDepth: 0,
      delivered: 0,
      retries: 0,
      credentialExpired: false,
    }),
    onError: () => {},
  }
  const server = await openLocalStatus(input)
  try {
    await assert.rejects(openLocalStatus(input))
    assert.equal((await read(port)).code, 200)
  } finally {
    await server.close()
  }
})

test('closing status destroys incomplete requests and releases the port', async () => {
  const port = await availablePort()
  const server = await openLocalStatus({
    port,
    read: () => ({
      queueDepth: 0,
      delivered: 0,
      retries: 0,
      credentialExpired: false,
    }),
    onError: () => {},
  })
  const socket = connect(port, '127.0.0.1')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write('GET / HTTP/1.1\r\n')
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    )
    await server.close()
    await closed
    const replacement = await openLocalStatus({
      port,
      read: () => ({
        queueDepth: 0,
        delivered: 0,
        retries: 0,
        credentialExpired: false,
      }),
      onError: () => {},
    })
    await replacement.close()
  } finally {
    socket.destroy()
  }
})
