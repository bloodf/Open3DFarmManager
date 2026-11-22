import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchJobFile,
  JobFileError,
} from '../../packages/connector/src/runtime/job-file-fetch.ts'

const cert = await readFile(
  new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url),
)
const key = await readFile(
  new URL('../fixtures/bambu-ftps/key.pem', import.meta.url),
)

test('refuses redirects to loopback with the generic refusal code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-file-redirect-'))
  const server = createServer({ cert, key }, (_req, res) => {
    res.writeHead(302, { location: 'https://127.0.0.1:1/private' })
    res.end()
  })

  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address !== 'string')
    await assert.rejects(
      fetchJobFile({
        job: {
          file_url: `https://localhost:${address.port}/file`,
          sha256: '0'.repeat(64),
          size_bytes: 0,
          display_name: 'test.gcode',
        },
        target: { backend: 'moonraker', origin: 'http://127.0.0.1:1' },
        directory,
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
    try {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
