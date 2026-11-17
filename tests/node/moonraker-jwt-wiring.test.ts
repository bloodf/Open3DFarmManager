import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  validateMoonrakerInput,
  moonrakerAuthHeaders,
} from '../../packages/connector/src/config/moonraker.ts'
import {
  openMoonrakerClient,
  readMoonrakerReady,
} from '../../packages/connector/src/moonraker/client.ts'
import { createMoonrakerSocket } from '../../packages/connector/src/moonraker/socket.ts'
import { createRequire } from 'node:module'
import type * as Ws from '../../packages/connector/node_modules/@types/ws/index.d.ts'
const { WebSocketServer } = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('ws') as typeof Ws
const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  staleAfterMs: 1000,
  reconnectMinMs: 100,
  reconnectMaxMs: 1000,
}
test('private JWT authenticates HTTP, refresh and oneshot websocket collection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonraker-jwt-wiring-'))
  let logins = 0,
    refreshes = 0,
    shots = 0,
    reads = 0
  const token = () =>
    `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 30 })).toString('base64url')}.x`
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/access/login') {
      logins++
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        assert.deepEqual(JSON.parse(body), {
          username: 'fixture',
          password: 'fixture-secret',
        })
        res.end(
          JSON.stringify({
            result: { token: token(), refresh_token: 'refresh' },
          }),
        )
      })
      return
    }
    assert.equal(req.headers['x-api-key'], undefined)
    if (req.url === '/access/refresh_jwt') {
      assert.equal(req.headers.authorization, 'Bearer refresh')
      refreshes++
      res.end(JSON.stringify({ result: { token: token() } }))
      return
    }
    assert.match(req.headers.authorization ?? '', /^Bearer x\./)
    if (req.url === '/access/oneshot_token') {
      shots++
      res.end(JSON.stringify({ result: 'single-use' }))
    } else {
      assert.equal(req.url, '/server/info')
      reads++
      res.end(
        JSON.stringify({
          result: { klippy_connected: true, klippy_state: 'ready' },
        }),
      )
    }
  })
  const ws = new WebSocketServer({ server })
  ws.on('connection', (peer, req) => {
    assert.equal(req.url, '/websocket?token=single-use')
    assert.equal(req.headers.authorization, undefined)
    peer.on('message', (data) => {
      const request = JSON.parse(data.toString())
      if (request.method === 'server.connection.identify') {
        peer.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { connection_id: 1 },
          }),
        )
        return
      }
      assert.equal(request.method, 'printer.objects.subscribe')
      peer.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { status: {} },
        }),
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const file = join(dir, 'credentials.json')
  const credential = { origin, username: 'fixture', password: 'fixture-secret' }
  writeFileSync(file, JSON.stringify(credential), { mode: 0o600 })
  const input = {
    assignment: { printerKey: 'fixture', origin, apiKeyFile: file },
    allowedOrigins: [origin],
    limits,
  }
  try {
    const checked = validateMoonrakerInput(input)
    assert.ok(!JSON.stringify(checked).includes('fixture-secret'))
    const signal = new AbortController().signal
    await readMoonrakerReady({ ...checked, signal })
    await readMoonrakerReady({ ...checked, signal })
    const client = openMoonrakerClient({ ...checked, signal, onStatus() {} })
    try {
      assert.deepEqual(await client.snapshot, { status: {} })
    } finally {
      client.close()
      await client.closed
    }
    assert.equal(logins, 1)
    assert.equal(reads, 2)
    assert.equal(shots, 1)
    assert.equal(refreshes, 2)
    writeFileSync(file, JSON.stringify({ ...credential, apiKey: 'mixed' }))
    assert.throws(() => validateMoonrakerInput(input), {
      message: 'Invalid private Moonraker credential',
    })
  } finally {
    for (const peer of ws.clients) peer.terminate()
    ws.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true })
  }
})
