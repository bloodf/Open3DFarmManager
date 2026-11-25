// SPDX-License-Identifier: MIT
/**
 * Stock and secure Creality file journeys against creality-simulator.ts, which
 * is reference-derived (nothing was captured from a printer). A journey is
 * list, upload, list, start, as the browser drives it. When the list fails,
 * the earliest cause is reported and nothing is uploaded or commanded.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionCrealityPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedCrealityControl } from '../../packages/connector/src/creality/control-driver.ts'
import {
  CrealityFileListError,
  listCrealityFiles,
} from '../../packages/connector/src/creality/files.ts'
import {
  createFileList,
  readPrinterFiles,
} from '../../packages/connector/src/runtime/file-list.ts'
import { uploadFile } from '../../packages/connector/src/runtime/file-upload.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws')

let directory: string
let key: string
let cert: string
let caFile: string
let filePath: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'creality-journeys-'))
  caFile = join(directory, 'cert.pem')
  const keyFile = join(directory, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      caFile,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  key = await readFile(keyFile, 'utf8')
  cert = await readFile(caFile, 'utf8')
  filePath = join(directory, 'part.gcode')
  await writeFile(filePath, 'G28\n')
})
after(() => rm(directory, { recursive: true, force: true }))

type Endpoint = {
  host: string
  port: number
  transport?: 'ws' | 'wss'
  httpsPort?: number
  caFile?: string
}

function bind(endpoint: Endpoint) {
  return provisionCrealityPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'p1',
    },
    { printerKey: 'p1', ...endpoint },
  )
}
const listInput = (binding: ReturnType<typeof bind>) => ({
  binding,
  signal: new AbortController().signal,
  authorized: () => true,
})
async function failure(
  promise: Promise<unknown>,
): Promise<CrealityFileListError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof CrealityFileListError, String(error))
    return error
  }
  throw Error('The listing succeeded')
}

/** What the browser receives on the file channel for one list request. */
async function listOnChannel(binding: ReturnType<typeof bind>) {
  const sent: Array<Record<string, unknown>> = []
  const failures: unknown[][] = []
  const handle = {
    current: { printer_key: 'p1', actions: ['start_print'], role: 'owner' },
  }
  const channel = createFileList({
    targetFor: () => ({ backend: 'creality', binding }),
    onFailure: (...values: unknown[]) => failures.push(values),
    admittedHandle: () => handle as never,
    send: (wire) => sent.push(JSON.parse(wire)),
  })
  channel.receive(
    JSON.stringify({
      type: 'files.list',
      request_id: 'r1',
      printer_key: 'p1',
    }),
  )
  await channel.settled()
  channel.close()
  return { reply: sent[0]!, failures }
}

const print = async (
  binding: ReturnType<typeof bind>,
  file: string,
): Promise<void> => {
  const control = openFixedCrealityControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal: new AbortController().signal,
  })
  try {
    await control.prepare()
    await control.driver.execute!(
      'start_print',
      { file },
      {
        binding,
        signal: new AbortController().signal,
        beforeSend: () => true,
      },
    )
  } finally {
    await control.close()
  }
}

test('stock journey: list, upload, list and start over the plain endpoint', async () => {
  const sim = await createCrealitySimulator(
    { state: 0 },
    { gcodeDirectory: '/mnt/UDISK/printer_data/gcodes' },
  )
  try {
    const endpoint = {
      host: '127.0.0.1',
      port: sim.port,
      transport: 'ws' as const,
    }
    const binding = bind(endpoint)
    assert.deepEqual(await listCrealityFiles(listInput(binding)), [])
    await uploadFile({
      target: {
        backend: 'creality',
        origin: `http://127.0.0.1:${sim.httpPort}`,
        endpoint,
      },
      filePath,
      name: 'part.gcode',
      signal: new AbortController().signal,
      authorize: () => true,
    })
    const [file] = await listCrealityFiles(listInput(binding))
    assert.equal(file!.printRef, 'creality-udisk:part.gcode')
    await print(binding, file!.printRef!)
    assert.deepEqual(sim.requests, [
      { method: 'get', params: { reqGcodeFile: 1 } },
      { method: 'get', params: { reqGcodeFile: 1 } },
      {
        method: 'set',
        params: {
          opGcodeFile: 'printprt:/mnt/UDISK/printer_data/gcodes/part.gcode',
        },
      },
    ])
  } finally {
    await sim.close()
  }
})

test('a refused or dropped socket reports connect or closed', async () => {
  const gone = await createCrealitySimulator({})
  const port = gone.port
  await gone.close()
  const refused = await failure(
    listCrealityFiles(
      listInput(bind({ host: '127.0.0.1', port, transport: 'ws' })),
    ),
  )
  assert.deepEqual([refused.reason, refused.requestSent], ['connect', false])

  const sim = await createCrealitySimulator({})
  try {
    sim.control.faults.addFault({
      fault: { type: 'drop' },
      path: '/',
      method: 'PUBLISH',
    })
    const dropped = await failure(
      listCrealityFiles(
        listInput(bind({ host: '127.0.0.1', port: sim.port, transport: 'ws' })),
      ),
    )
    assert.deepEqual([dropped.reason, dropped.requestSent], ['closed', true])
    assert.deepEqual(sim.requests, [])
  } finally {
    await sim.close()
  }
})

for (const [name, reply, reason] of [
  ['a malformed report', { retGcodeFileInfo2: 'x' }, 'reply-invalid'],
  [
    'duplicate names',
    {
      retGcodeFileInfo2: [
        '/usr/data/printer_data/gcodes/a.gcode',
        '/mnt/UDISK/printer_data/gcodes/a.gcode',
      ].map((path) => ({ name: 'a.gcode', size: 1, path })),
    },
    'ambiguous-names',
  ],
] as const)
  test(`${name} lists nothing and records its own reason`, async () => {
    const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(ws, 'listening')
    const messages: unknown[] = []
    ws.on('connection', (socket: import('ws').WebSocket) => {
      socket.on('message', (data) => {
        messages.push(JSON.parse(data.toString()))
        socket.send(JSON.stringify(reply))
      })
    })
    try {
      const binding = bind({
        host: '127.0.0.1',
        port: ws.address().port,
        transport: 'ws',
      })
      const { reply: wire, failures } = await listOnChannel(binding)
      // `offline`, not `unsupported`: nothing may be started by typed name.
      assert.equal(wire.reason, 'offline')
      assert.equal('files' in wire, false)
      assert.deepEqual(failures, [['p1', reason, true]])
      assert.deepEqual(messages, [
        { method: 'get', params: { reqGcodeFile: 1 } },
      ])
    } finally {
      for (const socket of ws.clients) socket.terminate()
      await new Promise<void>((resolve) => ws.close(() => resolve()))
    }
  })

test('revoked authority and cancellation stop before the request', async () => {
  const sim = await createCrealitySimulator({})
  try {
    const binding = bind({
      host: '127.0.0.1',
      port: sim.port,
      transport: 'ws',
    })
    const revoked = await failure(
      listCrealityFiles({ ...listInput(binding), authorized: () => false }),
    )
    assert.deepEqual(
      [revoked.reason, revoked.requestSent],
      ['unauthorized', false],
    )
    const cancelled = await failure(
      readPrinterFiles(
        { backend: 'creality', binding },
        {
          signal: AbortSignal.abort(),
          authorized: () => true,
          previews: false,
        },
      ),
    )
    assert.deepEqual(
      [cancelled.reason, cancelled.requestSent],
      ['cancelled', false],
    )
    assert.deepEqual(sim.received, [])
  } finally {
    await sim.close()
  }
})

// The secure cases come last: once a host advertised a secure endpoint the
// Connector never reaches it in plaintext again in the same process.
test('secure journey: list, upload and start never touch a plaintext listener', async () => {
  const sim = await createCrealitySimulator(
    { state: 0 },
    { secure: { key, cert } },
  )
  try {
    const endpoint = {
      host: '127.0.0.1',
      port: sim.port,
      httpsPort: sim.securePort!,
      caFile,
    }
    const binding = bind(endpoint)
    assert.deepEqual(await listCrealityFiles(listInput(binding)), [])
    await uploadFile({
      target: {
        backend: 'creality',
        origin: `http://127.0.0.1:${sim.httpPort}`,
        endpoint,
      },
      filePath,
      name: 'part.gcode',
      signal: new AbortController().signal,
      authorize: () => true,
    })
    assert.equal(sim.secureUploads, 1)
    const [file] = await listCrealityFiles(listInput(binding))
    assert.equal(file!.name, 'part.gcode')
    await print(binding, file!.name)
    assert.equal(sim.state.state, 1)
    assert.equal((sim.calls() as Record<string, number>).UPGRADE ?? 0, 0)
    assert.deepEqual(sim.httpCalls(), {})
  } finally {
    await sim.close()
  }
})

test('secure upload is refused, not downgraded, when the endpoint cannot be verified', async () => {
  const sim = await createCrealitySimulator({}, { secure: { key, cert } })
  try {
    await assert.rejects(
      uploadFile({
        target: {
          backend: 'creality',
          origin: `http://127.0.0.1:${sim.httpPort}`,
          // No CA: the synthetic certificate cannot be trusted.
          endpoint: {
            host: '127.0.0.1',
            port: sim.port,
            httpsPort: sim.securePort!,
          },
        },
        filePath,
        name: 'part.gcode',
        signal: new AbortController().signal,
        authorize: () => true,
      }),
      /Creality HTTPS discovery failed/,
    )
    assert.equal(sim.uploads.size, 0)
    assert.deepEqual(sim.httpCalls(), {})
  } finally {
    await sim.close()
  }
})

test('endpoint failure is the earliest reason: no socket, no request, no dispatch', async () => {
  const sim = await createCrealitySimulator({}, { secure: { key, cert } })
  try {
    // An untrusted certificate fails discovery before any WebSocket opens.
    const binding = bind({
      host: '127.0.0.1',
      port: sim.port,
      httpsPort: sim.securePort!,
    })
    const error = await failure(listCrealityFiles(listInput(binding)))
    assert.equal(error.reason, 'endpoint')
    assert.equal(error.requestSent, false)
    assert.match(error.message, /Creality HTTPS discovery failed/)
    const { reply, failures } = await listOnChannel(binding)
    assert.equal(reply.ok, false)
    assert.equal(reply.reason, 'offline')
    assert.deepEqual(failures, [['p1', 'endpoint', false]])
    assert.equal(sim.secureConnections, 0)
    assert.deepEqual(sim.received, [])
    assert.equal(sim.uploads.size, 0)
  } finally {
    await sim.close()
  }
})
