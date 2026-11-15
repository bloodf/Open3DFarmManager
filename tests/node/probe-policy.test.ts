import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
import { createPrinterNetworkPolicy } from '../../packages/connector/src/provisioning/policy.ts'
import { scanConfigurationDiscovery } from '../../packages/connector/src/runtime/configuration-discovery.ts'
import type { ConfigurationAuthority } from '../../packages/connector/src/runtime/configuration-authority.ts'

const policy = createPrinterNetworkPolicy(['192.168.50.0/24'])

test('refused hosts never open HTTP or TLS sockets', async (t) => {
  const httpRequest = t.mock.method(http, 'request', () => {
    throw new Error('forbidden HTTP connection')
  })
  const tlsConnect = t.mock.method(tls, 'connect', () => {
    throw new Error('forbidden TLS connection')
  })
  syncBuiltinESMExports()
  try {
    for (const host of [
      '127.0.0.1',
      '169.254.169.254',
      '8.8.8.8',
      'localhost',
      '::1',
      '192.168.51.10',
    ]) {
      assert.equal(policy.allows(host), false)
      assert.deepEqual(
        await scanConfigurationDiscovery(
          {} as ConfigurationAuthority,
          'refused',
          undefined,
          host,
          policy,
        ),
        { request_id: 'refused', ok: false, reason: 'failed' },
      )
    }
    assert.equal(httpRequest.mock.callCount(), 0)
    assert.equal(tlsConnect.mock.callCount(), 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('allowed private host is probed through a loopback fixture', async (t) => {
  let requests = 0
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET')
    if (req.url === '/') {
      res.writeHead(400).end()
      return
    }
    requests++
    assert.equal(req.url, '/server/info')
    res.end(JSON.stringify({ result: { moonraker_version: 'fixture' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const request = http.request
  const connect = tls.connect
  // Redirect transport only: policy still evaluates the requested private host.
  t.mock.method(
    http,
    'request',
    (
      options: http.RequestOptions,
      callback: (res: http.IncomingMessage) => void,
    ) => {
      assert.equal(options.host, '192.168.50.10')
      return request(
        { ...options, host: '127.0.0.1', port: address.port },
        callback,
      )
    },
  )
  t.mock.method(tls, 'connect', (options: tls.ConnectionOptions) => {
    assert.equal(options.host, '192.168.50.10')
    return connect({ ...options, host: '127.0.0.1', port: address.port })
  })
  syncBuiltinESMExports()
  try {
    const result = await scanConfigurationDiscovery(
      {} as ConfigurationAuthority,
      'allowed',
      undefined,
      '192.168.50.10',
      policy,
    )
    assert.deepEqual(result, {
      request_id: 'allowed',
      ok: true,
      printers: [{ vendor: 'moonraker', host: '192.168.50.10', port: 7125 }],
    })
    assert.equal(requests, 17)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
