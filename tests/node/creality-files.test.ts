import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
import { provisionCrealityPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { buildCrealityCommand } from '../../packages/connector/src/creality/commands.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { PrinterFile } from '../../packages/farm-protocol/src/file-list.ts'
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
      ws.once(
        'connection',
        (socket: {
          once(
            event: 'message',
            listener: (data: Buffer, binary: boolean) => void,
          ): unknown
        }) =>
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

function listInput(port: number) {
  return {
    binding: provisionCrealityPrinter(
      {
        assignment_id: randomUUID(),
        printer_key: 'p1',
        farm_id: randomUUID(),
        agent_id: randomUUID(),
      },
      { printerKey: 'p1', host: '127.0.0.1', transport: 'ws', port },
    ),
    signal: new AbortController().signal,
    authorized: () => true,
  }
}

test('Creality lists its simulated stock G-code directory and keeps the selected path', async () => {
  assert.deepEqual(CREALITY_FILE_CAPABILITIES, {
    upload: true,
    list: true,
    start: true,
  })
  const dir = await mkdtemp(join(tmpdir(), 'creality-list-'))
  const sim = await createCrealitySimulator(
    {},
    {
      gcodeDirectory: '/mnt/UDISK/printer_data/gcodes',
    },
  )
  try {
    const input = listInput(sim.port)
    await assert.rejects(
      listCrealityFiles({ ...input, authorized: () => false }),
      /unauthorized/,
    )
    assert.deepEqual(sim.requests, [])
    assert.deepEqual(await listCrealityFiles(input), [])
    const name = 'specimen.gcode'
    const filePath = join(dir, name)
    await writeFile(filePath, 'G28\n')
    await uploadCrealityFile({
      name,
      filePath,
      origin: `http://127.0.0.1:${sim.httpPort}`,
      signal: input.signal,
    })
    const files = await listCrealityFiles(input)
    assert.deepEqual(
      files.map((file) => PrinterFile.parse(file)),
      [
        {
          name,
          size: sim.uploads.get(name),
          modified: 0,
          printRef: 'creality-udisk:specimen.gcode',
        },
      ],
    )
    assert.deepEqual(sim.requests, [
      { method: 'get', params: { reqGcodeFile: 1 } },
      { method: 'get', params: { reqGcodeFile: 1 } },
    ])
    assert.deepEqual(
      buildCrealityCommand('start_print', { file: files[0]!.printRef }),
      {
        method: 'set',
        params: {
          opGcodeFile: 'printprt:/mnt/UDISK/printer_data/gcodes/specimen.gcode',
        },
      },
    )
    assert.throws(
      () =>
        buildCrealityCommand('start_print', {
          file: 'creality-udisk:../specimen.gcode',
        }),
      /filename/,
    )
  } finally {
    await sim.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Creality listing keeps reported stock paths and skips unknown or missing paths', async () => {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(ws, 'listening')
  ws.on('connection', (socket: import('ws').WebSocket) => {
    socket.once('message', () => {
      socket.send(
        JSON.stringify({
          retGcodeFileInfo2: [
            {
              name: 'legacy.gcode',
              size: 42,
              path: '/usr/data/printer_data/gcodes/legacy.gcode',
            },
            { name: 'missing.gcode', size: 10 },
            {
              name: 'unrecognized.gcode',
              size: 10,
              path: '/tmp/unrecognized.gcode',
            },
            {
              name: 'mismatched.gcode',
              size: 10,
              path: '/mnt/UDISK/printer_data/gcodes/another.gcode',
            },
          ],
        }),
      )
    })
  })
  try {
    assert.deepEqual(await listCrealityFiles(listInput(ws.address().port)), [
      { name: 'legacy.gcode', size: 42, modified: 0 },
    ])
  } finally {
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>((resolve) => ws.close(() => resolve()))
  }
})

test('Creality listing replies to heartbeat and refuses ambiguous stock paths', async () => {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => ws.once('listening', resolve))
  const messages: string[] = []
  ws.on('connection', (socket: import('ws').WebSocket) => {
    socket.on('message', (data) => {
      messages.push(data.toString())
      if (data.toString() !== 'ok') {
        socket.send(JSON.stringify({ ModeCode: 'heart_beat' }))
        return
      }
      const name = 'duplicate.gcode'
      socket.send(
        JSON.stringify({
          retGcodeFileInfo2: [
            {
              name,
              size: 42,
              path: '/usr/data/printer_data/gcodes/duplicate.gcode',
            },
            {
              name,
              size: 42,
              path: '/mnt/UDISK/printer_data/gcodes/duplicate.gcode',
            },
          ],
        }),
      )
    })
  })
  try {
    await assert.rejects(
      listCrealityFiles(listInput(ws.address().port)),
      /Ambiguous Creality filenames/,
    )
    assert.deepEqual(messages, [
      '{"method":"get","params":{"reqGcodeFile":1}}',
      'ok',
    ])
  } finally {
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>((resolve) => ws.close(() => resolve()))
  }
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
