import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { fetchJobFile, JobFileError } from '../../packages/connector/src/runtime/job-file-fetch.ts'

const cert = await readFile(new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url))
const key = await readFile(new URL('../fixtures/bambu-ftps/key.pem', import.meta.url))

test('refuses redirects to loopback with the generic refusal code', async () => {
  const server = createServer({ cert, key }, (_req, res) => {
    res.writeHead(302, { location: 'https://127.0.0.1:1/private' })
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    await assert.rejects(
      fetchJobFile({
        job: {
          file_url: `https://localhost:${address.port}/file`,
          sha256: '0'.repeat(64),
          size_bytes: 0,
          display_name: 'test.gcode',
        },
        target: { backend: 'moonraker', origin: 'http://127.0.0.1:1' },
        directory: '/tmp/job-file-redirect-test',
        signal: new AbortController().signal,
        ca: cert,
        authorize: () => true,
        async start() {},
      }),
      (error: unknown) =>
        error instanceof JobFileError && error.reason === 'download-refused',
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
