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
import { readMoonrakerReady } from '../../packages/connector/src/moonraker/client.ts'
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
test('private key authenticates local HTTP and websocket; legacy stays anonymous', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonraker-auth-'))
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], 'synthetic-key')
    assert.equal(req.url, '/server/info')
    res.end(
      JSON.stringify({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    )
  })
  const ws = new WebSocketServer({ server })
  ws.on('connection', (peer, req) => {
    assert.equal(req.headers['x-api-key'], 'synthetic-key')
    peer.close()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const file = join(dir, 'key.json')
  writeFileSync(file, JSON.stringify({ origin, apiKey: 'synthetic-key' }), {
    mode: 0o600,
  })
  const input = {
    assignment: { printerKey: 'test', origin, apiKeyFile: file },
    allowedOrigins: [origin],
    limits,
  }
  try {
    const checked = validateMoonrakerInput(input)
    await readMoonrakerReady({
      ...checked,
      signal: new AbortController().signal,
    })
    const socket = createMoonrakerSocket(origin, checked.limits)
    await once(socket, 'close')
    assert.throws(
      () => moonrakerAuthHeaders('http://localhost:1', checked.limits),
      /credential origin/,
    )
    assert.deepEqual(
      moonrakerAuthHeaders(
        origin,
        validateMoonrakerInput({
          ...input,
          assignment: { printerKey: 'legacy', origin },
        }).limits,
      ),
      {},
    )
    for (const path of [file, join(dir, 'missing')]) {
      chmodSync(file, 0o644)
      assert.throws(
        () =>
          validateMoonrakerInput({
            ...input,
            assignment: { ...input.assignment, apiKeyFile: path },
          }),
        { message: 'Invalid private Moonraker credential' },
      )
    }
    chmodSync(file, 0o600)
    writeFileSync(
      file,
      JSON.stringify({ origin: 'http://localhost:1', apiKey: 'synthetic-key' }),
    )
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
