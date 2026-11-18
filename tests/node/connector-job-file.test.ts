import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, readdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
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

test('verifies before upload, starts after upload, and removes staged files', async () => {
  const data = Buffer.from('G28\n')
  let body = data
  let uploads = 0
  let rejectUpload = false
  const events: string[] = []
  let mode: 'normal' | 'redirect' | 'timeout' | 'chunked' = 'normal'
  const source = createHttpsServer({ cert, key }, (_req, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' })
      res.end()
      return
    }
    if (mode === 'timeout') return
    if (mode === 'chunked') {
      res.write(body)
      res.end()
      return
    }
    res.end(body)
  })
  const printer = createHttpServer((req, res) => {
    uploads++
    req.resume()
    req.on('end', () => {
      events.push('upload')
      res.statusCode = rejectUpload ? 500 : 200
      res.end()
    })
  })
  source.listen(0, '127.0.0.1')
  printer.listen(0, '127.0.0.1')
  await Promise.all([once(source, 'listening'), once(printer, 'listening')])
  const sourceAddress = source.address()
  const printerAddress = printer.address()
  assert(sourceAddress && typeof sourceAddress !== 'string')
  assert(printerAddress && typeof printerAddress !== 'string')
  const directory = await mkdtemp(join(tmpdir(), 'job-file-test-'))
  const input = {
    job: {
      file_url: `https://localhost:${sourceAddress.port}/file`,
      sha256: createHash('sha256').update(data).digest('hex'),
      size_bytes: data.length,
      display_name: 'test.gcode',
    },
    target: {
      backend: 'moonraker' as const,
      origin: `http://127.0.0.1:${printerAddress.port}`,
    },
    directory,
    ca: cert,
    signal: new AbortController().signal,
    authorize: () => true,
    async start() {
      events.push('start')
    },
  }
  try {
    await fetchJobFile(input)
    assert.deepEqual(events, ['upload', 'start'])
    assert.deepEqual(await readdir(directory), [])
    body = Buffer.from('bad!')
    await assert.rejects(
      fetchJobFile(input),
      (error: unknown) =>
        error instanceof JobFileError && error.reason === 'checksum-mismatch',
    )
    body = Buffer.from('oversized')
    await assert.rejects(
      fetchJobFile(input),
      (error: unknown) =>
        error instanceof JobFileError && error.reason === 'too-large',
    )
    await assert.rejects(
      fetchJobFile({ ...input, target: { backend: 'anycubic' } }),
      (error: unknown) =>
        error instanceof JobFileError && error.reason === 'unsupported',
    )
    mode = 'chunked'
    await assert.rejects(
      fetchJobFile(input),
      (error: unknown) =>
        error instanceof JobFileError && error.reason === 'too-large',
    )
    mode = 'redirect'
    await assert.rejects(
      fetchJobFile(input),
      (error: unknown) =>
        error instanceof JobFileError && error.reason === 'download-failed',
    )
    mode = 'timeout'
    await assert.rejects(fetchJobFile({ ...input, timeoutMs: 50 }))
    mode = 'normal'
    body = data
    rejectUpload = true
    await assert.rejects(fetchJobFile(input))
    assert.equal(uploads, 2)
    assert.deepEqual(events, ['upload', 'start', 'upload'])
    assert.deepEqual(await readdir(directory), [])
  } finally {
    source.closeAllConnections()
    printer.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => printer.close(() => resolve())),
    ])
    await rmdir(directory)
  }
})
