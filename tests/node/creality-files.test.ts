import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  uploadCrealityFile,
  startCrealityPrint,
  listCrealityFiles,
  CREALITY_FILE_CAPABILITIES,
  CREALITY_MAX_FILE_BYTES,
} from '../../packages/connector/src/creality/files.ts'
const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws')

test('staged upload streams multipart to stock HTTP; start sends a 9999 text command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'creality-files-'))
  const filePath = join(directory, 'staged')
  await writeFile(filePath, 'G28\nG1 X10\n')
  let body = ''
  let requests = 0
  const server = createServer(async (req, res) => {
    requests++
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/upload/test%20part.gcode')
    assert.match(
      req.headers['content-type']!,
      /^multipart\/form-data; boundary=/,
    )
    for await (const chunk of req) body += chunk.toString()
    res.writeHead(201).end()
  })
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(ws, 'listening')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const signal = new AbortController().signal
  try {
    await uploadCrealityFile({
      origin,
      filePath,
      name: 'test part.gcode',
      signal,
    })
    assert.equal(requests, 1)
    assert.match(body, /name="file"; filename="test part.gcode"/)
    assert.ok(body.includes('G28\nG1 X10\n'))
    const received = new Promise<unknown>((resolve) =>
      ws.once('connection', (socket: import('ws').WebSocket) =>
        socket.once('message', (data, binary) => {
          assert.equal(binary, false)
          resolve(JSON.parse(data.toString()))
        }),
      ),
    )
    assert.deepEqual(
      await startCrealityPrint({
        host: '127.0.0.1',
        port: ws.address().port,
        name: 'test part.gcode',
        signal,
      }),
      { status: 'sent' },
    )
    assert.deepEqual(await received, {
      method: 'set',
      params: {
        opGcodeFile: 'printprt:/usr/data/printer_data/gcodes/test part.gcode',
      },
    })
    for (const name of [
      '../bad.gcode',
      'bad\r\n.gcode',
      'bad".gcode',
      'bad.3mf',
      'a'.repeat(256) + '.gcode',
    ]) {
      await assert.rejects(
        uploadCrealityFile({ origin, filePath, name, signal }),
        /filename/,
      )
      await assert.rejects(
        startCrealityPrint({ host: '127.0.0.1', name, signal }),
        /filename/,
      )
    }
    await truncate(filePath, CREALITY_MAX_FILE_BYTES + 1)
    await assert.rejects(
      uploadCrealityFile({ origin, filePath, name: 'test.gcode', signal }),
      /size/,
    )
    assert.equal(requests, 1)
    const aborted = AbortSignal.abort()
    await assert.rejects(
      uploadCrealityFile({
        origin,
        filePath,
        name: 'test.gcode',
        signal: aborted,
      }),
    )
    await assert.rejects(
      startCrealityPrint({
        host: '127.0.0.1',
        name: 'test.gcode',
        signal: aborted,
      }),
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>((resolve) => ws.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
})

test('undocumented listing is explicitly unsupported', async () => {
  assert.deepEqual(CREALITY_FILE_CAPABILITIES, {
    upload: true,
    list: false,
    start: true,
  })
  await assert.rejects(
    listCrealityFiles(),
    /unsupported: Creality stock file listing is undocumented/,
  )
})

test('HTTP failure and redirects cannot report an upload success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'creality-files-'))
  const filePath = join(directory, 'staged')
  await writeFile(filePath, 'G28\n')
  let status = 413
  const server = createServer((_req, res) =>
    res.writeHead(status, { location: 'http://127.0.0.1:1/' }).end(),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const input = {
      origin: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
      filePath,
      name: 'test.gcode',
      signal: new AbortController().signal,
    }
    await assert.rejects(uploadCrealityFile(input), /HTTP 413/)
    status = 302
    await assert.rejects(uploadCrealityFile(input))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
})
