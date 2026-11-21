// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createKobraLinkClient,
  KobraLinkError,
} from '../../packages/connector/src/kobralink/client.ts'
import { createControlFixture } from '../fixtures/kobralink-integration/control.ts'

const origin = 'http://127.0.0.1:7100'
const binding = { id: 'printer-1', deviceId: 'synthetic-device' }
const CONTROL_DELAY_MS = 5_500
const UPLOAD_DELAY_MS = 5_500
/** Large enough that a fixed 5 s deadline fails before the slow endpoint responds. */
const UPLOAD_BYTES = 256 * 1024

function slowJson(delayMs: number, data: unknown, status = 200) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('control requests keep the 5 s base deadline', async () => {
  const client = createKobraLinkClient({
    origin,
    allowedOrigins: [origin],
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/api/v1/setup/status')
        return slowJson(CONTROL_DELAY_MS, { needsSetup: false })()
      return new Response('{}', { status: 404 })
    },
  })
  await assert.rejects(client.setupStatus(), (error: unknown) => {
    assert.ok(error instanceof KobraLinkError)
    assert.equal(error.code, 'timeout')
    return true
  })
})

test('large uploads get a size-aware deadline on a slow endpoint', async () => {
  const fixture = createControlFixture()
  fixture.state.printState = 'standby'
  const dir = await mkdtemp(join(tmpdir(), 'kobralink-upload-deadline-'))
  const path = join(dir, 'large.gcode')
  await writeFile(path, 'x'.repeat(UPLOAD_BYTES))
  try {
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch: async (url, init) => {
        const pathname = new URL(url).pathname
        if (
          pathname.endsWith('/files') &&
          init.method === 'POST' &&
          init.body instanceof FormData
        )
          return slowJson(UPLOAD_DELAY_MS, { id: 'uploaded-1' })()
        return fixture.fetch(url, init)
      },
    })
    await client.authenticate({
      ownership: 'fresh_owned',
      mode: 'signin',
      name: 'Connector',
      email: 'c@example.test',
      password: 'synthetic-password',
    })
    const result = await client.uploadFile(binding, path, 'large.gcode')
    assert.deepEqual(result, { id: 'uploaded-1' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})