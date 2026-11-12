import { test, expect } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  symlinkSync,
  linkSync,
  renameSync,
  mkdirSync,
  rmdirSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { serveWsTestServer, type WsTestSocket } from './ws-serve.ts'
import { collectStream } from './streams.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { main } from '../../packages/connector/src/cli.ts'

function resource(value: object) {
  if (process.env.MOONRAKER_TEST_LEDGER)
    appendFileSync(
      process.env.MOONRAKER_TEST_LEDGER,
      JSON.stringify(value) + '\n',
    )
}
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'open3d-collect-'))
  resource({ kind: 'directory', id: path, state: 'created' })
  return {
    path,
    close() {
      rmSync(path, { recursive: true })
      resource({ kind: 'directory', id: path, state: 'removed' })
    },
  }
}
const selected = (progress = 0.25) => ({
  webhooks: { state: 'ready' },
  print_stats: { state: 'printing' },
  virtual_sdcard: { progress },
})
const snapshot = () =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { eventtime: 10, status: selected() },
  })
const update = (eventtime: number, progress: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'notify_status_update',
    params: [{ virtual_sdcard: { progress } }, eventtime],
  })
async function loopback(
  input: {
    subscribe?: (socket: WsTestSocket) => void
    hangUpgrade?: boolean
  } = {},
) {
  const sockets = new Set<WsTestSocket>()
  const requests: { path: string; extension: string | null }[] = []
  const server = await serveWsTestServer({
    http(request) {
      requests.push({
        path: new URL(request.url).pathname,
        extension: request.headers.get('sec-websocket-extensions'),
      })
      return Response.json({
        result: { klippy_connected: true, klippy_state: 'ready' },
      })
    },
    upgrade(request) {
      const path = new URL(request.url).pathname
      requests.push({
        path,
        extension: request.headers.get('sec-websocket-extensions'),
      })
      if (path === '/websocket') return input.hangUpgrade ? 'hang' : true
      return false
    },
    onOpen(socket) {
      sockets.add(socket)
    },
    onMessage(socket) {
      input.subscribe ? input.subscribe(socket) : socket.send(snapshot())
    },
    onClose(socket) {
      sockets.delete(socket)
    },
  })
  const port = server.port
  resource({ kind: 'loopback', id: port, state: 'created' })
  return {
    origin: `http://127.0.0.1:${port}`,
    sockets,
    requests,
    async close() {
      for (const socket of sockets) socket.terminate()
      await server.stop()
      resource({ kind: 'loopback', id: port, state: 'closed' })
    },
  }
}
function config(
  path: string,
  origin: string,
  printers = [{ printerKey: 'A/\u{1f600}/a', origin }],
) {
  const file = join(path, 'private-config.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      allowedOrigins: [origin],
      printers,
      limits: {
        connectTimeoutMs: 1500,
        requestTimeoutMs: 1500,
        staleAfterMs: 5000,
        reconnectMinMs: 100,
        reconnectMaxMs: 500,
      },
    }),
    { mode: 0o600 },
  )
  return file
}
function launch(args: string[], auditPath?: string) {
  const child = spawn(
    'node',
    [
      '--import',
      './tests/helpers/moonraker-collect-load-audit.ts',
      'packages/connector/src/cli.ts',
      ...args,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Prove the CLI sets policy itself, even when another test loaded ws.
        WS_NO_BUFFER_UTIL: '',
        WS_NO_UTF_8_VALIDATE: '',
        ...(auditPath ? { OPEN3D_LOAD_AUDIT: auditPath } : {}),
      },
    },
  )
  resource({ kind: 'child', id: child.pid, state: 'created' })
  let output = ''
  const stdout = (async () => {
    for await (const part of child.stdout!) output += part.toString('utf8')
  })()
  const stderr = collectStream(child.stderr)
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  let recorded = false
  void exited.catch(() => {})
  async function finish() {
    let code: number | null
    try {
      code = await exited
      await stdout
    } finally {
      clearTimeout(timer)
    }
    if (!recorded) {
      resource({ kind: 'child', id: child.pid, state: 'reaped' })
      recorded = true
    }
    return { code, output, error: await stderr }
  }
  return {
    get output() {
      return output
    },
    async until(predicate: (text: string) => boolean) {
      const deadline = Date.now() + 5000
      while (!predicate(output)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error('CLI fixture condition was not reached')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    finish,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM')
      return finish()
    },
    async close() {
      if (child.exitCode === null) child.kill('SIGKILL')
      await finish()
    },
  }
}
const queued = (text: string) =>
  text.split('\n').filter((line) => line.includes('"kind":"queued"')).length

test('actual Node CLI persists opaque-key snapshots and FIFO deltas before queued diagnostics', async () => {
  const service = await loopback()
  const temp = temporary()
  const data = join(temp.path, 'data')
  const audit = join(temp.path, 'load-audit.txt')
  const job = launch(
    [
      'collect',
      '--config',
      config(temp.path, service.origin),
      '--data-dir',
      data,
    ],
    audit,
  )
  try {
    await job.until((text) => queued(text) === 1)
    const log = join(data, 'telemetry', 'telemetry.jsonl')
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean).length).toBe(1)
    for (const socket of service.sockets) socket.send(update(11, 0.5))
    await job.until((text) => queued(text) === 2)
    const before = readFileSync(log)
    const result = await job.stop()
    expect(result.code).toBe(0)
    expect(result.error).toBe('')
    expect(service.sockets.size).toBe(0)
    expect(existsSync(join(data, 'identity.json'))).toBe(false)
    expect(existsSync(join(data, 'telemetry', 'telemetry.lock'))).toBe(false)
    expect(readFileSync(log)).toEqual(before)
    const queue = new TelemetryQueue(join(data, 'telemetry'), Date.now())
    try {
      const records = queue.batch(Date.now()).records
      expect(
        records.flatMap((record) =>
          record.kind === 'printer-state'
            ? [[record.state.printerKey, record.state.progress]]
            : [],
        ),
      ).toEqual([
        ['A/\u{1f600}/a', 0.25],
        ['A/\u{1f600}/a', 0.5],
      ])
      expect(new Set(records.map((record) => record.eventId)).size).toBe(2)
    } finally {
      queue.close()
    }
    expect(service.requests.map((request) => request.path)).toEqual([
      '/server/info',
      '/websocket',
    ])
    expect(
      service.requests.every((request) => request.extension === null),
    ).toBe(true)
    expect(readFileSync(audit, 'utf8')).toContain('ws-safe')
    expect(readFileSync(audit, 'utf8')).not.toContain('addon-request')
    expect(result.output).not.toContain(service.origin)
    expect(result.output).not.toContain('A/')
    expect(result.output).not.toContain(temp.path)
  } finally {
    await job.close()
    await service.close()
    temp.close()
  }
}, 10000)

test('a print state change queues a transition event before its state snapshot', async () => {
  const service = await loopback()
  const temp = temporary()
  const data = join(temp.path, 'data')
  const job = launch(
    [
      'collect',
      '--config',
      config(temp.path, service.origin),
      '--data-dir',
      data,
    ],
    join(temp.path, 'load-audit.txt'),
  )
  try {
    await job.until((text) => queued(text) === 1)
    for (const socket of service.sockets)
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notify_status_update',
          params: [{ print_stats: { state: 'error' } }, 11],
        }),
      )
    await job.until((text) => queued(text) === 2)
    expect((await job.stop()).code).toBe(0)
    const queue = new TelemetryQueue(join(data, 'telemetry'), Date.now())
    try {
      const records = queue.batch(Date.now()).records
      expect(records.map((record) => record.kind)).toEqual([
        'printer-state',
        'printer-transition',
        'printer-state',
      ])
      expect(records[1]).toMatchObject({
        transition: { from: 'printing', to: 'error' },
      })
    } finally {
      queue.close()
    }
  } finally {
    await job.close()
    await service.close()
    temp.close()
  }
}, 10000)

test('all configuration validates before networking or creating a queue', async () => {
  const service = await loopback()
  try {
    for (const mode of [
      'later-printer',
      'duplicate',
      'unknown',
      'oversized',
      'utf8',
      'public',
      'symlink',
      'hardlink',
    ]) {
      const temp = temporary()
      const file = config(temp.path, service.origin)
      const data = join(temp.path, 'absent')
      const original = JSON.parse(readFileSync(file, 'utf8'))
      if (mode === 'later-printer')
        original.printers.push({
          printerKey: 'second',
          origin: 'http://example.invalid',
        })
      if (mode === 'duplicate')
        original.printers.push({ ...original.printers[0] })
      if (mode === 'unknown') original.backend = service.origin
      writeFileSync(file, JSON.stringify(original), { mode: 0o600 })
      if (mode === 'oversized') writeFileSync(file, ' '.repeat(64 * 1024 + 1))
      if (mode === 'utf8') writeFileSync(file, Buffer.from([0xff]))
      if (mode === 'public') chmodSync(file, 0o644)
      if (mode === 'symlink') {
        renameSync(file, file + '.target')
        symlinkSync(file + '.target', file)
      }
      if (mode === 'hardlink') linkSync(file, file + '.link')
      const job = launch(['collect', '--config', file, '--data-dir', data])
      try {
        const result = await job.finish()
        expect(result.code).toBe(1)
        expect(result.output).toBe('')
        expect(result.error).not.toContain(file)
        expect(existsSync(data)).toBe(false)
      } finally {
        await job.close()
        temp.close()
      }
    }
    expect(service.requests).toEqual([])
  } finally {
    await service.close()
  }
}, 20000)

test('FIFO configuration is rejected without blocking the actual CLI', async () => {
  const temp = temporary()
  const fifo = join(temp.path, 'config-fifo')
  const make = spawnSync('mkfifo', ['-m', '600', fifo], {
    encoding: 'utf8',
  })
  resource({ kind: 'child', id: make.pid, state: 'created' })
  expect(make.status).toBe(0)
  resource({ kind: 'child', id: make.pid, state: 'reaped' })
  const data = join(temp.path, 'absent')
  const job = launch(['collect', '--config', fifo, '--data-dir', data])
  try {
    const result = await job.finish()
    expect(result.code).toBe(1)
    expect(result.output).toBe('')
    expect(existsSync(data)).toBe(false)
  } finally {
    await job.close()
    temp.close()
  }
}, 10000)

test('a real queue append failure aborts every subscription with no false queued receipt', async () => {
  const service = await loopback()
  const temp = temporary()
  const data = join(temp.path, 'data')
  const file = config(temp.path, service.origin, [
    { printerKey: 'one', origin: service.origin },
    { printerKey: 'two', origin: service.origin },
  ])
  const job = launch(['collect', '--config', file, '--data-dir', data])
  const log = join(data, 'telemetry', 'telemetry.jsonl')
  try {
    await job.until((text) => queued(text) === 2)
    expect(service.sockets.size).toBe(2)
    const before = readFileSync(log)
    renameSync(log, log + '.saved')
    mkdirSync(log, { mode: 0o700 })
    for (const socket of service.sockets) socket.send(update(11, 0.7))
    const result = await job.finish()
    expect(result.code).toBe(1)
    expect(queued(result.output)).toBe(2)
    expect(service.sockets.size).toBe(0)
    expect(result.error).not.toContain(temp.path)
    expect(existsSync(join(data, 'telemetry', 'telemetry.lock'))).toBe(false)
    rmdirSync(log)
    renameSync(log + '.saved', log)
    expect(readFileSync(log)).toEqual(before)
    const recovered = new TelemetryQueue(join(data, 'telemetry'), Date.now())
    try {
      expect(recovered.depth).toBe(2)
    } finally {
      recovered.close()
    }
  } finally {
    await job.close()
    await service.close()
    temp.close()
  }
}, 10000)

test('recovery losses are surfaced before collecting and stale locks stay fail-closed', async () => {
  const service = await loopback()
  const temp = temporary()
  const data = join(temp.path, 'data')
  const directory = join(data, 'telemetry')
  const old = Date.now() - 25 * 60 * 60 * 1000
  const queue = new TelemetryQueue(directory, old)
  queue.enqueue(
    { printerKey: 'old', progress: 0.1, state: 'idle', observedAt: old },
    old,
  )
  queue.close()
  appendFileSync(join(directory, 'telemetry.jsonl'), '{torn')
  const file = config(temp.path, service.origin)
  const job = launch(['collect', '--config', file, '--data-dir', data])
  try {
    await job.until((text) => queued(text) === 1)
    const result = await job.stop()
    const first = JSON.parse(result.output.split('\n')[0]!)
    expect(first).toEqual({
      kind: 'loss',
      phase: 'recovery',
      expired: 1,
      capacity: 0,
      partialTail: true,
    })
    expect(result.code).toBe(0)
    writeFileSync(join(directory, 'telemetry.lock'), '{"pid":999999}', {
      mode: 0o600,
    })
    const requestCount = service.requests.length
    const blocked = launch(['collect', '--config', file, '--data-dir', data])
    try {
      expect((await blocked.finish()).code).toBe(1)
      expect(readFileSync(join(directory, 'telemetry.lock'), 'utf8')).toBe(
        '{"pid":999999}',
      )
      expect(service.requests.length).toBe(requestCount)
    } finally {
      await blocked.close()
    }
  } finally {
    await job.close()
    await service.close()
    temp.close()
  }
}, 10000)

test('abort during a pending WebSocket upgrade destroys the connection and closes the queue', async () => {
  const service = await loopback({ hangUpgrade: true })
  const temp = temporary()
  const data = join(temp.path, 'data')
  const job = launch([
    'collect',
    '--config',
    config(temp.path, service.origin),
    '--data-dir',
    data,
  ])
  try {
    await job.until(() =>
      service.requests.some((request) => request.path === '/websocket'),
    )
    const result = await job.stop()
    expect(result.code).toBe(0)
    expect(queued(result.output)).toBe(0)
    expect(existsSync(join(data, 'telemetry', 'telemetry.lock'))).toBe(false)
  } finally {
    await job.close()
    await service.close()
    temp.close()
  }
}, 10000)

test('identity main remains synchronous and help does not load ws', async () => {
  expect(typeof main(['--version'])).toBe('number')
  const temp = temporary()
  const audit = join(temp.path, 'audit')
  const job = launch(['--help'], audit)
  try {
    const result = await job.finish()
    expect(result.code).toBe(0)
    expect(result.output).toContain('collect --config')
    expect(existsSync(audit)).toBe(false)
  } finally {
    await job.close()
    temp.close()
  }
}, 10000)

test('ws rejects oversized and excessively fragmented messages before any queue callback', async () => {
  for (const mode of ['oversized', 'fragmented']) {
    const temp = temporary()
    const server = spawn(
      'node',
      ['packages/connector/test/moonraker-fragment-server.ts', mode],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    resource({ kind: 'child', id: server.pid, state: 'created' })
    const serverError = collectStream(server.stderr)
    const serverExited = new Promise<number | null>((resolve) =>
      server.on('exit', (code) => resolve(code)),
    )
    const timer = setTimeout(() => server.kill('SIGKILL'), 8000)
    const stdoutIter = server.stdout![Symbol.asyncIterator]()
    let origin: string | undefined
    let job: ReturnType<typeof launch> | undefined
    try {
      const first = await stdoutIter.next()
      origin = JSON.parse(first.value!.toString('utf8')).origin
      if (!origin) throw new Error('Missing fixture origin')
      resource({ kind: 'loopback', id: origin, state: 'created' })
      const data = join(temp.path, 'data')
      job = launch([
        'collect',
        '--config',
        config(temp.path, origin),
        '--data-dir',
        data,
      ])
      await job.until((text) => text.includes('"reason":"invalid-response"'))
      const result = await job.stop()
      expect(result.code).toBe(0)
      expect(queued(result.output)).toBe(0)
      const queue = new TelemetryQueue(join(data, 'telemetry'), Date.now())
      try {
        expect(queue.depth).toBe(0)
      } finally {
        queue.close()
      }
    } finally {
      await job?.close()
      if (server.exitCode === null) {
        try {
          server.stdin!.write('stop')
          server.stdin!.end()
        } catch {
          server.kill('SIGKILL')
        }
      }
      await serverExited
      clearTimeout(timer)
      let closeTrace = ''
      for (;;) {
        const part = await stdoutIter.next()
        if (part.done) break
        closeTrace += part.value!.toString('utf8')
      }
      const error = await serverError
      resource({ kind: 'child', id: server.pid, state: 'reaped' })
      if (origin) resource({ kind: 'loopback', id: origin, state: 'closed' })
      temp.close()
      expect(error).toBe('')
      expect(closeTrace).toContain(
        `"closeCode":${mode === 'oversized' ? 1009 : 1008}`,
      )
    }
  }
}, 20000)
