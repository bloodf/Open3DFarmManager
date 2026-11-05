import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetryHttpSender } from '../../packages/connector/src/cloud/http-telemetry.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { ingestTelemetry } from '../../apps/farm/server/services/telemetry.ts'
import { MemoryTelemetryStore } from '../helpers/memory-telemetry-store.ts'
const id = '00000000-0000-4000-8000-000000000001'
const state = {
  printerKey: 'synthetic',
  state: 'printing' as const,
  progress: 0.5,
  observedAt: 1000,
}
const body = JSON.stringify([
  { eventId: id, kind: 'printer-state', queuedAt: 1000, state },
])
async function server(handler: RequestListener) {
  const instance = createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(instance.address() as AddressInfo).port}/synthetic-ingestion`
  return {
    endpoint,
    close: async () => {
      instance.closeAllConnections()
      await new Promise<void>((resolve) => instance.close(() => resolve()))
    },
  }
}
const sender = (endpoint: string, timeoutMs = 1000) =>
  createTelemetryHttpSender({
    endpoint,
    timeoutMs,
    allowLoopbackHttpForTests: true,
  })

test(
  'real loopback POST connects durable queue to synthetic ingestion and acknowledgement',
  { timeout: 5000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open3d-http-'))
    const queue = new TelemetryQueue(directory, 1000)
    const store = new MemoryTelemetryStore()
    const http = await server((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        void ingestTelemetry(
          Buffer.concat(chunks).toString(),
          { farmId: id, agentId: id, printerKeys: new Set(['synthetic']) },
          store,
        ).then((result) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(result))
        })
      })
    })
    try {
      queue.enqueue(state, 1000)
      assert.equal(
        (
          await drainTelemetryOnce(
            queue,
            sender(http.endpoint),
            () => 1000,
            new AbortController().signal,
          )
        ).status,
        'delivered',
      )
      assert.equal(queue.depth, 0)
      assert.equal(store.size, 1)
    } finally {
      queue.close()
      rmSync(directory, { recursive: true, force: true })
      await http.close()
    }
  },
)

test(
  'deadline cancels stalled headers and stalled body and closes the response',
  { timeout: 5000 },
  async (t) => {
    for (const phase of ['headers', 'body']) {
      let closed!: () => void
      let arrived!: () => void
      let fireDeadline!: () => void
      const closeObserved = new Promise<void>((resolve) => {
        closed = resolve
      })
      const ready = new Promise<void>((resolve) => {
        arrived = resolve
      })
      const http = await server((request, response) => {
        request.resume()
        response.on('close', closed)
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.write('{')
        }
        // Keep the server phase open across a delayed readiness notification.
        setTimeout(arrived, 150)
      })
      const originalSetTimeout = globalThis.setTimeout
      const timer = t.mock.method(
        globalThis,
        'setTimeout',
        (...args: Parameters<typeof setTimeout>) => {
          if (args[1] === 27193) fireDeadline = () => args[0]()
          return originalSetTimeout(...args)
        },
      )
      try {
        const attempt = assert.rejects(
          sender(http.endpoint, 27193)(body, new AbortController().signal),
          /Telemetry transport failed/,
        )
        // The watchdog bounds a handler that never arrives, including an early failure.
        let watchdog!: ReturnType<typeof setTimeout>
        try {
          await Promise.race([
            ready,
            new Promise<never>((_, reject) => {
              watchdog = originalSetTimeout(
                () => reject(new Error('Request did not reach handler')),
                2000,
              )
            }),
          ])
        } finally {
          clearTimeout(watchdog)
        }
        assert.equal(typeof fireDeadline, 'function')
        fireDeadline()
        await attempt
        await Promise.race([
          closeObserved,
          new Promise<never>((_, reject) => {
            watchdog = originalSetTimeout(
              () => reject(new Error('Response did not close')),
              2000,
            )
          }),
        ]).finally(() => clearTimeout(watchdog))
      } finally {
        timer.mock.restore()
        await http.close()
      }
    }
  },
)

test(
  'real deadline rejects a stalled request without relying on handler arrival',
  { timeout: 5000 },
  async () => {
    const http = await server((request) => {
      request.resume()
    })
    try {
      await assert.rejects(
        sender(http.endpoint, 50)(body, new AbortController().signal),
        /Telemetry transport failed/,
      )
    } finally {
      await http.close()
    }
  },
)

test(
  'caller abort ends actual body streaming and releases queue slot after transport settles',
  { timeout: 5000 },
  async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const http = await server((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
      started()
    })
    const directory = mkdtempSync(join(tmpdir(), 'open3d-http-abort-'))
    const queue = new TelemetryQueue(directory, 1000)
    try {
      queue.enqueue(state, 1000)
      const controller = new AbortController()
      const attempt = drainTelemetryOnce(
        queue,
        sender(http.endpoint),
        () => 1000,
        controller.signal,
      )
      await ready
      controller.abort()
      assert.equal((await attempt).status, 'retained')
      // A second attempt may remain busy until native fetch observes the abort.
      let result
      for (let i = 0; i < 100; i++) {
        result = await drainTelemetryOnce(
          queue,
          async (raw) =>
            JSON.parse(raw).map((row: { eventId: string }) => row.eventId),
          () => 1000,
          new AbortController().signal,
        )
        if (result.status === 'delivered') break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(result?.status, 'delivered')
    } finally {
      queue.close()
      rmSync(directory, { recursive: true, force: true })
      await http.close()
    }
  },
)

test(
  'oversized, malformed UTF-8, ambiguous JSON, wrong MIME/status and redirects reject',
  { timeout: 5000 },
  async () => {
    for (const kind of [
      'oversized',
      'utf8',
      'duplicate',
      'mime',
      'status',
      'redirect',
    ]) {
      let requests = 0
      const http = await server((request, response) => {
        request.resume()
        requests++
        if (kind === 'redirect') {
          response.writeHead(302, { location: '/unexpected' })
          response.end()
          return
        }
        response.writeHead(kind === 'status' ? 401 : 200, {
          'content-type': kind === 'mime' ? 'text/plain' : 'application/json',
        })
        response.end(
          kind === 'oversized'
            ? 'x'.repeat(8193)
            : kind === 'utf8'
              ? Buffer.from([0xff])
              : kind === 'duplicate'
                ? '{"ok":true,"ok":true,"acceptedEventIds":[]}'
                : JSON.stringify({ ok: true, acceptedEventIds: [id] }),
        )
      })
      try {
        await assert.rejects(
          sender(http.endpoint)(body, new AbortController().signal),
          /Telemetry transport failed/,
        )
        assert.equal(requests, 1)
      } finally {
        await http.close()
      }
    }
  },
)

test(
  'unsafe endpoints and invalid outbound payloads fail before any request',
  { timeout: 5000 },
  async () => {
    for (const endpoint of [
      'http://example.com/',
      'http://localhost/',
      'https://user:password@example.com/',
      'https://example.com/?token=x',
    ])
      assert.throws(() => sender(endpoint), /configuration/)
    assert.throws(
      () =>
        createTelemetryHttpSender({
          endpoint: 'http://127.0.0.1/',
          timeoutMs: 1000,
        }),
      /configuration/,
    )
    let requests = 0
    const http = await server((_request, response) => {
      requests++
      response.end()
    })
    try {
      await assert.rejects(
        sender(http.endpoint)(
          '{"action":"pause"}',
          new AbortController().signal,
        ),
        /Telemetry transport failed/,
      )
      assert.equal(requests, 0)
    } finally {
      await http.close()
    }
  },
)

test(
  'one hundred accepted event IDs fit the bounded response parser',
  { timeout: 5000 },
  async () => {
    const eventIds = Array.from(
      { length: 100 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    )
    const batch = JSON.stringify(
      eventIds.map((eventId) => ({
        eventId,
        queuedAt: 1000,
        kind: 'printer-state',
        state,
      })),
    )
    const http = await server((request, response) => {
      request.resume()
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
      })
      response.end(JSON.stringify({ ok: true, acceptedEventIds: eventIds }))
    })
    try {
      assert.deepEqual(
        await sender(http.endpoint)(batch, new AbortController().signal),
        eventIds,
      )
    } finally {
      await http.close()
    }
  },
)

test('invalid endpoint configuration never exposes URL parser input or underlying errors', () => {
  const marker = 'SYNTHETIC_PRIVATE_CONFIG_MARKER'
  for (const options of [
    { endpoint: `https://${marker}@[invalid`, timeoutMs: 1000 },
    {
      get endpoint(): string {
        throw new Error(marker)
      },
      timeoutMs: 1000,
    },
  ]) {
    assert.throws(
      () => createTelemetryHttpSender(options),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Invalid telemetry transport configuration')
        assert.equal('input' in error, false)
        assert.equal('cause' in error, false)
        assert.equal(JSON.stringify(error).includes(marker), false)
        return true
      },
    )
  }
})

test('ambiguous endpoint syntax and oversized configuration reject before URL normalization', () => {
  for (const endpoint of [
    'https://safe\n.example/telemetry',
    ' https://safe.example/telemetry',
    'https://safe.example\\telemetry',
    'https://safe.example/' + 'a'.repeat(2048),
  ])
    assert.throws(
      () => createTelemetryHttpSender({ endpoint, timeoutMs: 1000 }),
      /configuration/,
    )
})

test(
  'endpoint is snapshotted and cross-origin redirects never contact the second loopback server',
  { timeout: 5000 },
  async () => {
    let targetCalls = 0,
      originCalls = 0,
      redirect = false
    const target = await server((request, response) => {
      request.resume()
      targetCalls++
      response.end()
    })
    const origin = await server((request, response) => {
      request.resume()
      originCalls++
      if (redirect) {
        response.writeHead(307, { location: target.endpoint })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, acceptedEventIds: [id] }))
    })
    try {
      const config = {
        endpoint: origin.endpoint,
        timeoutMs: 1000,
        allowLoopbackHttpForTests: true,
      }
      const send = createTelemetryHttpSender(config)
      config.endpoint = target.endpoint
      assert.deepEqual(await send(body, new AbortController().signal), [id])
      redirect = true
      await assert.rejects(
        send(body, new AbortController().signal),
        (error) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'Telemetry transport failed')
          assert.equal('cause' in error, false)
          return true
        },
      )
      assert.equal(originCalls, 2)
      assert.equal(targetCalls, 0)
    } finally {
      await origin.close()
      await target.close()
    }
  },
)

test(
  'response limit rejects open-ended chunking and gzip expansion, with redacted errors',
  { timeout: 5000 },
  async () => {
    for (const kind of ['chunked', 'gzip']) {
      let closed!: () => void
      const observedClose = new Promise<void>((resolve) => {
        closed = resolve
      })
      const http = await server((request, response) => {
        request.resume()
        response.on('close', closed)
        response.writeHead(200, {
          'content-type': 'application/json',
          ...(kind === 'gzip' ? { 'content-encoding': 'gzip' } : {}),
        })
        if (kind === 'gzip')
          response.end(
            gzipSync('SYNTHETIC_PRIVATE_RESPONSE_MARKER'.repeat(1000)),
          )
        else response.write('x'.repeat(8193))
      })
      try {
        await assert.rejects(
          sender(http.endpoint)(body, new AbortController().signal),
          (error) => {
            assert.ok(error instanceof Error)
            assert.equal(error.message, 'Telemetry transport failed')
            assert.equal('cause' in error, false)
            assert.equal(
              JSON.stringify(error).includes('PRIVATE_RESPONSE'),
              false,
            )
            return true
          },
        )
        await observedClose
      } finally {
        await http.close()
      }
    }
  },
)

test(
  'destination and header fields injected into telemetry are rejected before network access',
  { timeout: 5000 },
  async () => {
    let originCalls = 0,
      targetCalls = 0
    const target = await server((request, response) => {
      request.resume()
      targetCalls++
      response.end()
    })
    const origin = await server((request, response) => {
      request.resume()
      originCalls++
      response.end()
    })
    try {
      const send = sender(origin.endpoint)
      const event = JSON.parse(body)[0]
      for (const field of [
        'endpoint',
        'url',
        'destination',
        'redirect',
        'headers',
        '__proto__',
      ]) {
        for (const injected of [
          { ...event, [field]: target.endpoint },
          { ...event, state: { ...event.state, [field]: target.endpoint } },
        ])
          await assert.rejects(
            send(JSON.stringify([injected]), new AbortController().signal),
            /Telemetry transport failed/,
          )
      }
      assert.equal(originCalls, 0)
      assert.equal(targetCalls, 0)
    } finally {
      await origin.close()
      await target.close()
    }
  },
)

test(
  'URL-shaped printer data remains data and malicious ingestion response cannot reconfigure subsequent delivery',
  { timeout: 5000 },
  async () => {
    let targetCalls = 0,
      maliciousResponse = true
    const target = await server((request, response) => {
      request.resume()
      targetCalls++
      response.end()
    })
    const directory = mkdtempSync(join(tmpdir(), 'open3d-destination-data-'))
    const queue = new TelemetryQueue(directory, 1000)
    const store = new MemoryTelemetryStore()
    const requestedPaths: string[] = []
    const origin = await server((request, response) => {
      requestedPaths.push(request.url ?? '')
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        void ingestTelemetry(
          Buffer.concat(chunks).toString(),
          { farmId: id, agentId: id, printerKeys: new Set([target.endpoint]) },
          store,
        ).then((result) => {
          response.writeHead(200, {
            'content-type': 'application/json',
            location: target.endpoint,
          })
          response.end(
            JSON.stringify(
              maliciousResponse
                ? { ...result, endpoint: target.endpoint }
                : result,
            ),
          )
        })
      })
    })
    try {
      queue.enqueue({ ...state, printerKey: target.endpoint }, 1000)
      const config = {
        endpoint: origin.endpoint,
        timeoutMs: 1000,
        allowLoopbackHttpForTests: true,
      }
      const send = createTelemetryHttpSender(config)
      const first = await drainTelemetryOnce(
        queue,
        send,
        () => 1000,
        new AbortController().signal,
      )
      assert.equal(first.status, 'retained')
      assert.equal(queue.depth, 1)
      assert.equal(store.size, 1)
      // Neither response data nor later mutation of caller-owned configuration changes the captured endpoint.
      config.endpoint = target.endpoint
      maliciousResponse = false
      assert.equal(
        (
          await drainTelemetryOnce(
            queue,
            send,
            () => 1000,
            new AbortController().signal,
          )
        ).status,
        'delivered',
      )
      assert.equal(queue.depth, 0)
      assert.equal(store.size, 1)
      assert.deepEqual(requestedPaths, [
        '/synthetic-ingestion',
        '/synthetic-ingestion',
      ])
      assert.equal(targetCalls, 0)
    } finally {
      queue.close()
      rmSync(directory, { recursive: true, force: true })
      await origin.close()
      await target.close()
    }
  },
)

test(
  'all redirect statuses retain the queued batch and never contact another origin',
  { timeout: 5000 },
  async () => {
    let status = 301,
      targetCalls = 0,
      originCalls = 0
    const target = await server((request, response) => {
      request.resume()
      targetCalls++
      response.end()
    })
    const origin = await server((request, response) => {
      request.resume()
      originCalls++
      response.writeHead(status, { location: target.endpoint })
      response.end()
    })
    const directory = mkdtempSync(join(tmpdir(), 'open3d-redirect-queue-'))
    const queue = new TelemetryQueue(directory, 1000)
    try {
      const eventId = queue.enqueue(state, 1000).eventId
      const send = sender(origin.endpoint)
      for (status of [301, 302, 303, 307, 308]) {
        const result = await drainTelemetryOnce(
          queue,
          send,
          () => 1000,
          new AbortController().signal,
        )
        assert.equal(result.status, 'retained')
        assert.deepEqual(
          queue.batch(1000).records.map((record) => record.eventId),
          [eventId],
        )
      }
      assert.equal(originCalls, 5)
      assert.equal(targetCalls, 0)
    } finally {
      queue.close()
      rmSync(directory, { recursive: true, force: true })
      await origin.close()
      await target.close()
    }
  },
)
