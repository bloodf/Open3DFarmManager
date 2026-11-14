import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { X509Certificate } from 'node:crypto'
import { uploadBambuFile } from '../../packages/connector/src/bambu/ftps.ts'
import { fixture } from '../fixtures/bambu-ftps/server.ts'

for (const scenario of [
  'success',
  'credentials',
  'trust',
  'timeout',
  'abort',
]) {
  test(scenario, async () => {
    const server = await fixture(scenario === 'timeout' || scenario === 'abort')
    const controller = new AbortController()
    const pin = createHash('sha256')
      .update(new X509Certificate(server.cert).raw)
      .digest('hex')
    const timer =
      scenario === 'abort'
        ? setTimeout(() => controller.abort(), 50)
        : undefined
    try {
      const promise = uploadBambuFile({
        host: '127.0.0.1',
        port: server.port,
        serial: 'TEST',
        accessCode: scenario === 'credentials' ? 'bad' : 'secret',
        trust: { pinSha256: scenario === 'trust' ? '0'.repeat(64) : pin },
        filePath: new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url)
          .pathname,
        name: 'test.3mf',
        signal: controller.signal,
        timeoutMs: 250,
      })
      if (scenario === 'success') {
        await promise
        assert.deepEqual(server.bytes(), server.cert)
      } else await assert.rejects(promise)
    } finally {
      clearTimeout(timer)
      await server.close()
    }
  })
}
