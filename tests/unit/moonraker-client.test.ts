import { test, expect } from 'bun:test'
import { appendFileSync } from 'node:fs'

// Opt-in resource diagnostics stay outside the checkout.
function recordResource(value: object) {
  const ledger = Bun.env.MOONRAKER_TEST_LEDGER
  if (ledger) appendFileSync(ledger, JSON.stringify(value) + '\n')
}
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import type { ServerWebSocket } from 'bun'
import { validateMoonrakerInput } from '../../packages/connector/src/moonraker/client.ts'

const status = {
  webhooks: { state: 'ready' },
  print_stats: { state: 'printing' },
  virtual_sdcard: { progress: 0.25 },
}
const ready = { result: { klippy_connected: true, klippy_state: 'ready' } }
const snapshot = (eventtime = 10) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { eventtime, status } })
const delta = (eventtime: number, progress: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'notify_status_update',
    params: [{ virtual_sdcard: { progress } }, eventtime],
  })

async function fixture(input: {
  http?: (request: Request) => Response
  subscribe: (
    socket: ServerWebSocket<undefined>,
    connection: number,
    later: (callback: () => void, ms: number) => void,
  ) => void
}) {
  let connections = 0
  const requests: { path: string; method: string }[] = []
  const rpcs: unknown[] = []
  const sockets = new Set<ServerWebSocket<undefined>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  function later(callback: () => void, ms: number) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, ms)
    timers.add(timer)
  }
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname
      requests.push({ path, method: request.method })
      if (path === '/websocket') {
        if (server.upgrade(request, { data: undefined })) return
        return new Response(null, { status: 400 })
      }
      return input.http?.(request) ?? Response.json(ready)
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        connections++
      },
      message(socket, message) {
        rpcs.push(JSON.parse(String(message)))
        input.subscribe(socket, connections, later)
      },
      close(socket) {
        sockets.delete(socket)
      },
    },
  })
  recordResource({ kind: 'loopback', port: server.port, state: 'created' })
  const port = server.port
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    rpcs,
    sockets,
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.terminate()
      await server.stop(true)
      recordResource({ kind: 'loopback', port, state: 'closed' })
    },
  }
}

async function run(
  origin: string,
  limits = {},
  mode = 'normal',
  durationMs = 800,
) {
  const process = Bun.spawn(
    [
      'node',
      'tests/helpers/moonraker-node-client.ts',
      origin,
      JSON.stringify(limits),
      mode,
      String(durationMs),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  recordResource({
    kind: 'node-child',
    pid: process.pid,
    origin,
    state: 'created',
  })
  const timer = setTimeout(() => process.kill(), 4000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.failure).toBe(
      mode === 'throw'
        ? 'callback-fixture'
        : mode === 'async'
          ? 'Moonraker onEvent must return synchronously with undefined'
          : null,
    )
    expect(output.events.length).toBe(output.countAtAbort)
    return output.events as Array<{
      kind: string
      reason?: string
      sourceEventtime?: number
      printer?: { progress: number }
    }>
  } finally {
    clearTimeout(timer)
    if (process.exitCode === null) {
      process.kill()
      await process.exited
    }
    recordResource({ kind: 'node-child', pid: process.pid, state: 'reaped' })
  }
}

test('Node client uses fixed read-only paths and subscription, merges and deduplicates deltas', async () => {
  const service = await fixture({
    subscribe(socket, _connection, later) {
      socket.send(snapshot())
      later(() => {
        socket.send(delta(11, 0.5))
        socket.send(delta(11, 0.5))
        socket.send(delta(9, 0.1))
        socket.send(delta(12, 0.5))
        for (const [eventtime, state] of [
          [13, 'standby'],
          [14, 'complete'],
        ]) {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'notify_status_update',
              params: [{ print_stats: { state } }, eventtime],
            }),
          )
        }
      }, 20)
    },
  })
  try {
    const events = await run(service.origin, { staleAfterMs: 2000 })
    expect(
      events
        .filter((event) => event.kind === 'snapshot')
        .map((event) => [event.sourceEventtime, event.printer?.progress]),
    ).toEqual([
      [10, 0.25],
      [11, 0.5],
      [13, 0.5],
    ])
    expect(service.requests).toEqual([
      { path: '/server/info', method: 'GET' },
      { path: '/websocket', method: 'GET' },
    ])
    expect(service.rpcs).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'printer.objects.subscribe',
        params: {
          objects: {
            webhooks: ['state'],
            print_stats: ['state'],
            virtual_sdcard: ['progress'],
          },
        },
      },
    ])
    expect(service.sockets.size).toBe(0)
  } finally {
    await service.close()
  }
}, 5000)

test('disconnect resubscribes with a fresh baseline and reset source clock', async () => {
  const service = await fixture({
    subscribe(socket, connection, later) {
      socket.send(snapshot(connection === 1 ? 100 : 1))
      if (connection === 1) later(() => socket.close(), 20)
    },
  })
  try {
    const events = await run(service.origin, { staleAfterMs: 2000 })
    expect(
      events
        .filter((event) => event.kind === 'snapshot')
        .map((event) => event.sourceEventtime),
    ).toEqual([100, 1])
    expect(events.some((event) => event.reason === 'offline')).toBe(true)
    expect(service.rpcs.length).toBe(2)
    expect(service.sockets.size).toBe(0)
  } finally {
    await service.close()
  }
}, 5000)

test('stale data fails closed and old updates cannot extend freshness', async () => {
  const service = await fixture({
    subscribe(socket, _connection, later) {
      socket.send(snapshot())
      later(() => socket.send(delta(9, 0.5)), 100)
    },
  })
  try {
    const events = await run(service.origin)
    expect(events.some((event) => event.reason === 'stale')).toBe(true)
    expect(service.rpcs.length).toBeGreaterThan(1)
    expect(
      events
        .filter((event) => event.kind === 'snapshot')
        .every((event) => event.printer?.progress === 0.25),
    ).toBe(true)
  } finally {
    await service.close()
  }
}, 5000)

test('invalid origins reject synchronously without any network request', async () => {
  const service = await fixture({ subscribe() {} })
  try {
    for (const origin of [
      service.origin + '?',
      service.origin + '#',
      service.origin.replace('127', '12\t7'),
      service.origin.replace('127', '12\n7'),
      service.origin + '/path/..',
      service.origin + '/other',
      service.origin + '?token=x',
      service.origin + '#x',
      'ftp://127.0.0.1',
      'http://user:pass@127.0.0.1',
      'http://127.0.0.1:1',
    ]) {
      expect(() =>
        createMoonrakerSubscription({
          assignment: { printerKey: 'p', origin },
          allowedOrigins: [service.origin],
          limits: {
            maxMessageBytes: 1024,
            connectTimeoutMs: 10,
            requestTimeoutMs: 10,
            staleAfterMs: 20,
            reconnectMinMs: 10,
            reconnectMaxMs: 20,
          },
          onEvent() {},
          signal: new AbortController().signal,
        }),
      ).toThrow()
    }
    expect(service.requests).toEqual([])
  } finally {
    await service.close()
  }
})

test('assignment keeps opaque keys and rejects invalid PostgreSQL UTF-8 keys', () => {
  const input = {
    assignment: {
      printerKey: 'A/\u{1f600}/a',
      origin: 'http://127.0.0.1:1234',
    },
    allowedOrigins: ['http://127.0.0.1:1234'],
    limits: {
      maxMessageBytes: 1024,
      connectTimeoutMs: 10,
      requestTimeoutMs: 10,
      staleAfterMs: 20,
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    },
  }
  expect(validateMoonrakerInput(input).printerKey).toBe('A/\u{1f600}/a')
  for (const printerKey of [
    '',
    'a'.repeat(129),
    '\u0000',
    '\ud800',
    '\udfff',
  ]) {
    expect(() =>
      validateMoonrakerInput({
        ...input,
        assignment: { ...input.assignment, printerKey },
      }),
    ).toThrow()
  }
  expect(() =>
    validateMoonrakerInput({ ...input, allowedOrigins: [] }),
  ).toThrow()
})

test('abort disposes pending HTTP, pending RPC and reconnect backoff', async () => {
  for (const mode of ['http', 'rpc', 'backoff']) {
    const service = await fixture({
      http() {
        if (mode === 'http')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'))
              },
            }),
          )
        return Response.json(
          mode === 'backoff'
            ? {
                result: {
                  klippy_connected: false,
                  klippy_state: 'disconnected',
                },
              }
            : ready,
        )
      },
      subscribe() {},
    })
    try {
      const events = await run(service.origin, {
        requestTimeoutMs: 2000,
        reconnectMinMs: 2000,
        reconnectMaxMs: 2000,
      })
      expect(events.some((event) => event.kind === 'snapshot')).toBe(false)
      expect(
        service.requests.filter((request) => request.path === '/server/info')
          .length,
      ).toBe(1)
      expect(service.sockets.size).toBe(0)
    } finally {
      await service.close()
    }
  }
}, 10000)

test('Node abort and callback failures release sockets without later events', async () => {
  for (const mode of ['pre-abort', 'abort-snapshot', 'throw', 'async']) {
    const service = await fixture({
      subscribe(socket) {
        socket.send(snapshot())
      },
    })
    try {
      const events = await run(service.origin, { staleAfterMs: 2000 }, mode)
      expect(service.sockets.size).toBe(0)
      if (mode === 'pre-abort') {
        expect(service.requests).toEqual([])
        expect(events).toEqual([])
      } else
        expect(events.filter((event) => event.kind === 'snapshot').length).toBe(
          1,
        )
    } finally {
      await service.close()
    }
  }
}, 10000)

test('Node rejects malformed, oversized, unmatched and premature status messages', async () => {
  for (const wire of [
    '{"jsonrpc":"2.0","id":1,"id":1,"result":{}}',
    snapshot().replace('"id":1', '"id":2'),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 1, message: 'fixture' },
    }),
    delta(11, 0.5),
    'x'.repeat(4097),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { eventtime: 10, status: {} },
    }),
  ]) {
    const service = await fixture({
      subscribe(socket) {
        socket.send(wire)
      },
    })
    try {
      const events = await run(service.origin)
      expect(events.some((event) => event.reason === 'invalid-response')).toBe(
        true,
      )
      expect(events.some((event) => event.kind === 'snapshot')).toBe(false)
    } finally {
      await service.close()
    }
  }
}, 12000)

test('equal-time conflicts and duplicate replies invalidate an established baseline', async () => {
  for (const wire of [
    delta(10, 0.7),
    snapshot(),
    delta(11, 2),
    Buffer.from('binary'),
  ]) {
    const service = await fixture({
      subscribe(socket, _connection, later) {
        socket.send(snapshot())
        later(() => socket.send(wire), 15)
      },
    })
    try {
      const events = await run(service.origin, { staleAfterMs: 2000 })
      expect(events.some((event) => event.reason === 'invalid-response')).toBe(
        true,
      )
      expect(
        events
          .filter((event) => event.kind === 'snapshot')
          .every((event) => event.printer?.progress === 0.25),
      ).toBe(true)
    } finally {
      await service.close()
    }
  }
}, 10000)

test('HTTP not-ready, redirects, body overflow and subscription timeout fail closed', async () => {
  for (const mode of [
    'not-ready',
    'redirect',
    'overflow',
    'invalid-utf8',
    'hang',
    'timeout',
  ]) {
    const service = await fixture({
      http() {
        if (mode === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { location: '/unexpected' },
          })
        if (mode === 'overflow') return new Response('x'.repeat(4097))
        if (mode === 'invalid-utf8')
          return new Response(
            Buffer.concat([
              Buffer.from(
                '{"result":{"klippy_connected":true,"klippy_state":"ready","ignored":"',
              ),
              Buffer.from([0xc0, 0xaf]),
              Buffer.from('"}}'),
            ]),
          )
        if (mode === 'hang')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"result":'))
              },
            }),
          )
        return Response.json(
          mode === 'not-ready'
            ? {
                result: {
                  klippy_connected: false,
                  klippy_state: 'disconnected',
                },
              }
            : ready,
        )
      },
      subscribe() {},
    })
    try {
      const events = await run(service.origin, { requestTimeoutMs: 100 })
      expect(events.some((event) => event.kind === 'snapshot')).toBe(false)
      expect(
        events.some(
          (event) =>
            event.kind === 'unavailable' && event.reason !== 'connecting',
        ),
      ).toBe(true)
      expect(
        service.requests.some((request) => request.path === '/unexpected'),
      ).toBe(false)
      expect(service.requests.length).toBeLessThan(20)
      expect(service.sockets.size).toBe(0)
    } finally {
      await service.close()
    }
  }
}, 10000)
