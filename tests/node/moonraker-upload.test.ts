import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  uploadMoonrakerFile,
  MoonrakerUploadError,
} from '../../packages/connector/src/moonraker/upload.ts'

test('streams multipart and maps failures without exposing keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moon-upload-'))
  const filePath = join(dir, 'file')
  await writeFile(filePath, 'G28\n')
  let status = 200
  let received = ''
  const server = createServer((req, res) => {
    assert.equal(req.url, '/server/files/upload')
    assert.equal(req.headers['x-api-key'], 'secret-key')
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      received += chunk
    })
    req.on('end', () => {
      if (status) res.writeHead(status).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const input = {
    origin,
    filePath,
    name: 'test.gcode',
    apiKey: 'secret-key',
    signal: new AbortController().signal,
  }
  try {
    await uploadMoonrakerFile(input)
    assert.match(received, /name="root"\r\n\r\ngcodes/)
    assert.match(received, /filename="test.gcode"/)
    assert.match(received, /G28/)
    for (const [code, reason] of [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [413, 'too-large'],
    ] as const) {
      status = code
      await assert.rejects(
        uploadMoonrakerFile(input),
        (error: unknown) =>
          error instanceof MoonrakerUploadError &&
          error.reason === reason &&
          !error.message.includes('secret-key'),
      )
    }
    status = 0
    const controller = new AbortController()
    const pending = uploadMoonrakerFile({ ...input, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof MoonrakerUploadError && error.reason === 'aborted',
    )
    await assert.rejects(
      uploadMoonrakerFile(input),
      (error: unknown) =>
        error instanceof MoonrakerUploadError && error.reason === 'timeout',
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
