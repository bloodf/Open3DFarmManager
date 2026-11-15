import test from 'node:test'
import assert from 'node:assert/strict'
import { scanConfigurationDiscovery } from '../../packages/connector/src/runtime/configuration-discovery.ts'
import type { ConfigurationAuthority } from '../../packages/connector/src/runtime/configuration-authority.ts'

test('refuses addresses outside printer networks before probing', async () => {
  for (const host of [
    '127.0.0.1',
    '169.254.169.254',
    '8.8.8.8',
    'localhost',
    '::1',
  ]) {
    assert.deepEqual(
      await scanConfigurationDiscovery(
        {} as ConfigurationAuthority,
        'request',
        undefined,
        host,
      ),
      {
        request_id: 'request',
        ok: false,
        reason: 'failed',
      },
    )
  }
})

test('an injected fixture policy permits a read-only probe', async () => {
  const { createServer } = await import('node:http')
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    assert.equal(req.url, '/server/info')
    res.end(JSON.stringify({ result: { moonraker_version: 'fixture' } }))
  })
  await new Promise<void>((resolve) =>
    server.listen(7125, '127.0.0.1', resolve),
  )
  try {
    const result = await scanConfigurationDiscovery(
      {} as ConfigurationAuthority,
      'allowed',
      undefined,
      '127.0.0.1',
      { allows: (host) => host === '127.0.0.1' },
    )
    assert.equal(result.ok, true)
    assert.equal(requests, 1)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
