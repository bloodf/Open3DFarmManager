import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  discoveryRequest,
  discoveryTargetHash,
} from '../../packages/farm-protocol/src/configuration-discovery.ts'
import { BrowserChannelMessage } from '../../packages/connector/src/webrtc/configuration-channel.ts'
import { scanConfigurationDiscovery } from '../../packages/connector/src/runtime/configuration-discovery.ts'
import type { ConfigurationAuthority } from '../../packages/connector/src/runtime/configuration-authority.ts'

test('probe authority target binds the exact host and differs from discovery', async () => {
  const frame = await discoveryRequest(randomUUID(), randomUUID(), '127.0.0.1')
  assert.equal(frame.target_sha256, await discoveryTargetHash('127.0.0.1'))
  assert.notEqual(frame.target_sha256, await discoveryTargetHash('127.0.0.2'))
  assert.notEqual(frame.target_sha256, await discoveryTargetHash())
  await assert.rejects(discoveryTargetHash('http://127.0.0.1'))
  assert.equal(
    BrowserChannelMessage.safeParse({
      v: 1,
      t: 'discovery',
      host: '127.0.0.1:7125',
      frame: 'x',
      capability: 'x',
      admission: 'x',
    }).success,
    false,
  )
})

test('loopback probe returns only public fields and shares the discovery lease', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/server/info')
    assert.equal(req.headers.authorization, undefined)
    res.end(
      JSON.stringify({
        result: { moonraker_version: 'test', api_key: 'secret' },
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(7125, '127.0.0.1', resolve)
  })
  try {
    const authority = {} as ConfigurationAuthority
    const id = randomUUID()
    const pending = scanConfigurationDiscovery(
      authority,
      id,
      undefined,
      '127.0.0.1',
    )
    const busyId = randomUUID()
    assert.deepEqual(await scanConfigurationDiscovery(authority, busyId), {
      request_id: busyId,
      ok: false,
      reason: 'busy',
    })
    const result = await pending
    assert.deepEqual(result, {
      request_id: id,
      ok: true,
      printers: [{ vendor: 'moonraker', host: '127.0.0.1', port: 7125 }],
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
