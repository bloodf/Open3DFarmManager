import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
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
  async () => {
    for (const phase of ['headers', 'body']) {
      let closed!: () => void
      const closeObserved = new Promise<void>((resolve) => {
        closed = resolve
      })
      const http = await server((request, response) => {
        request.resume()
        response.on('close', closed)
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.write('{')
        }
      })
      try {
        await assert.rejects(
          sender(http.endpoint, 100)(body, new AbortController().signal),
          /Telemetry transport failed/,
        )
        await closeObserved
      } finally {
        await http.close()
      }
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
