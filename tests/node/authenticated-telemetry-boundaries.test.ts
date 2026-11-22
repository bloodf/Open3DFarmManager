import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'

const id = '00000000-0000-4000-8000-000000000001'
const body = JSON.stringify([
  {
    eventId: id,
    queuedAt: 1000,
    kind: 'printer-state',
    state: {
      printerKey: 'synthetic',
      state: 'printing',
      progress: 0.5,
      observedAt: 1000,
    },
  },
])
const make = (endpoint: string, timeoutMs = 1000) =>
  createAuthenticatedTelemetrySender({
    endpoint,
    timeoutMs,
    token: 'aaa.bbb.ccc',
    agentId: id,
    farmId: id,
    audience: 'synthetic',
    identity: { signTelemetryProof: () => 'A'.repeat(86) },
    allowLoopbackHttpForTests: true,
  })

test('authenticated transport rejects malformed, oversized, compressed and redirected responses', async () => {
  let mode = ''
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/unexpected' })
      res.end()
      return
    }
    res.writeHead(mode === 'status' ? 401 : 200, {
      'content-type': mode === 'mime' ? 'text/plain' : 'application/json',
      ...(mode === 'gzip' ? { 'content-encoding': 'gzip' } : {}),
    })
    res.end(
      mode === 'oversized'
        ? 'x'.repeat(8193)
        : mode === 'utf8'
          ? Buffer.from([255])
          : mode === 'duplicate'
            ? '{"challenge":{},"challenge":{}}'
            : mode === 'gzip'
              ? gzipSync('PRIVATE_RESPONSE'.repeat(1000))
              : '{}',
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No port')
  const send = make(`http://127.0.0.1:${address.port}/api/connector/telemetry`)
  try {
    for (mode of [
      'oversized',
      'utf8',
      'duplicate',
      'mime',
      'status',
      'redirect',
      'gzip',
    ]) {
      const before = requests
      await assert.rejects(
        send(body, new AbortController().signal),
        (error: Error) => {
          assert.equal(error.message, 'Telemetry transport failed')
          assert.equal('cause' in error, false)
          assert.equal(
            JSON.stringify(error).includes('PRIVATE_RESPONSE'),
            false,
          )
          return true
        },
      )
      assert.equal(requests, before + 1)
    }
    const before = requests
    for (const field of [
      'endpoint',
      'url',
      'destination',
      'redirect',
      'headers',
      '__proto__',
    ]) {
      const event = JSON.parse(body)[0]
      for (const injected of [
        { ...event, [field]: 'http://127.0.0.1/' },
        { ...event, state: { ...event.state, [field]: 'http://127.0.0.1/' } },
      ])
        await assert.rejects(
          send(JSON.stringify([injected]), new AbortController().signal),
          /Telemetry transport failed/,
        )
    }
    assert.equal(requests, before)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('authenticated transport rejects unsafe configuration with redacted errors', () => {
  for (const endpoint of [
    'http://example.com/api/connector/telemetry',
    'http://localhost/api/connector/telemetry',
    'https://user:password@example.com/api/connector/telemetry',
    'https://example.com/api/connector/telemetry?token=x',
    'https://safe\n.example/api/connector/telemetry',
    ' https://safe.example/api/connector/telemetry',
    'https://safe.example\\api/connector/telemetry',
    'https://safe.example/' + 'a'.repeat(2048),
  ])
    assert.throws(
      () => make(endpoint),
      /Invalid telemetry transport configuration/,
    )
  const marker = 'SYNTHETIC_PRIVATE_CONFIG_MARKER'
  assert.throws(
    () => make(`https://${marker}@[invalid`),
    (error: Error) => {
      assert.equal(error.message, 'Invalid telemetry transport configuration')
      assert.equal('cause' in error, false)
      assert.equal('input' in error, false)
      assert.equal(JSON.stringify(error).includes(marker), false)
      return true
    },
  )
})

test(
  'authenticated client bounds stalled headers and response bodies and respects caller abort',
  { timeout: 5000 },
  async () => {
    let phase = 'headers'
    let arrived: (() => void) | undefined
    const server = createServer((req, res) => {
      req.resume()
      if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{')
      }
      arrived?.()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('No port')
    const endpoint = `http://127.0.0.1:${address.port}/api/connector/telemetry`
    try {
      for (phase of ['headers', 'body']) {
        await assert.rejects(
          make(endpoint, 50)(body, new AbortController().signal),
          /Telemetry transport failed/,
        )
        const controller = new AbortController()
        const ready = new Promise<void>((resolve) => {
          arrived = resolve
        })
        const pending = make(endpoint)(body, controller.signal)
        await ready
        controller.abort()
        await assert.rejects(pending, /Telemetry transport failed/)
        arrived = undefined
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)

test('one hundred IDs fit the authenticated response and endpoint is captured', async () => {
  const eventIds = Array.from(
    { length: 100 },
    (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
  )
  const batch = JSON.stringify(
    eventIds.map((eventId) => ({ ...JSON.parse(body)[0], eventId })),
  )
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  let requests = 0
  let responseMode = 'valid'
  const server = createServer(async (req, res) => {
    requests++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/challenge')) {
      const now = Date.now()
      res.end(
        JSON.stringify({
          challenge: {
            v: 2,
            purpose: 'telemetry-ingestion',
            method: 'POST',
            path: '/api/connector/telemetry',
            agent_id: id,
            farm_id: id,
            jti: randomUUID(),
            connection_id: randomUUID(),
            public_key_spki: spki.toString('base64url'),
            fingerprint:
              'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
            thumbprint: 'A'.repeat(43),
            token_hash: createHash('sha256')
              .update('aaa.bbb.ccc')
              .digest('base64url'),
            origin: 'https://farm.example',
            audience: 'synthetic',
            generation: 1,
            nonce: 'A'.repeat(43),
            issued_at: now,
            expires_at: now + 5000,
            body_sha256: createHash('sha256').update(raw).digest('base64url'),
            body_bytes: raw.length,
          },
        }),
      )
    } else if (responseMode === 'malicious') {
      res.end(
        JSON.stringify({
          ok: true,
          acceptedEventIds: eventIds,
          endpoint: 'http://127.0.0.1:9',
        }),
      )
    } else if (responseMode !== 'valid') {
      res.writeHead(Number(responseMode), { location: 'http://127.0.0.1:9' })
      res.end()
    } else res.end(JSON.stringify({ ok: true, acceptedEventIds: eventIds }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No port')
  try {
    const config = {
      endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
      timeoutMs: 1000,
      token: 'aaa.bbb.ccc',
      agentId: id,
      farmId: id,
      audience: 'synthetic',
      identity: { signTelemetryProof: () => 'A'.repeat(86) },
      allowLoopbackHttpForTests: true,
    }
    const send = createAuthenticatedTelemetrySender(config)
    config.endpoint = 'http://127.0.0.1:9/api/connector/telemetry'
    assert.deepEqual(await send(batch, new AbortController().signal), eventIds)
    assert.equal(requests, 2)
    for (responseMode of ['malicious', '301', '302', '303', '307', '308'])
      await assert.rejects(
        send(batch, new AbortController().signal),
        /Telemetry transport failed/,
      )
    responseMode = 'valid'
    assert.deepEqual(await send(batch, new AbortController().signal), eventIds)
    assert.equal(requests, 16)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

// Coverage moved from the removed prototype sender tests (#609).

async function listen(handler: Parameters<typeof createServer>[1]) {
  const instance = createServer(handler)
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  const address = instance.address()
  if (!address || typeof address === 'string') throw Error('No port')
  return {
    endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
    close: async () => {
      instance.closeAllConnections()
      await new Promise<void>((resolve) => instance.close(() => resolve()))
    },
  }
}

test('loopback HTTP requires the explicit test opt-in and throwing configuration stays redacted', () => {
  const base = {
    timeoutMs: 1000,
    token: 'aaa.bbb.ccc',
    agentId: id,
    farmId: id,
    audience: 'synthetic',
    identity: { signTelemetryProof: () => 'A'.repeat(86) },
  }
  assert.throws(
    () =>
      createAuthenticatedTelemetrySender({
        ...base,
        endpoint: 'http://127.0.0.1/api/connector/telemetry',
      }),
    /Invalid telemetry transport configuration/,
  )
  const marker = 'SYNTHETIC_PRIVATE_CONFIG_MARKER'
  assert.throws(
    () =>
      createAuthenticatedTelemetrySender({
        ...base,
        get endpoint(): string {
          throw new Error(marker)
        },
      }),
    (error: Error) => {
      assert.equal(error.message, 'Invalid telemetry transport configuration')
      assert.equal('cause' in error, false)
      assert.equal(JSON.stringify(error).includes(marker), false)
      return true
    },
  )
})

test('non-telemetry outbound payloads fail before any request', async () => {
  let requests = 0
  const http = await listen((req, res) => {
    requests++
    req.resume()
    res.end()
  })
  try {
    for (const payload of ['{"action":"pause"}', '[]', 'not json'])
      await assert.rejects(
        make(http.endpoint)(payload, new AbortController().signal),
        /Telemetry transport failed/,
      )
    assert.equal(requests, 0)
  } finally {
    await http.close()
  }
})

test(
  'deadline closes a stalled response and caller abort retains the queued batch then releases the slot',
  { timeout: 5000 },
  async () => {
    let closed!: () => void
    const closeObserved = new Promise<void>((resolve) => {
      closed = resolve
    })
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const http = await listen((req, res) => {
      req.resume()
      res.on('close', closed)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      started()
    })
    const directory = mkdtempSync(join(tmpdir(), 'open3d-auth-abort-'))
    const queue = new TelemetryQueue(directory, 1000)
    try {
      await assert.rejects(
        make(http.endpoint, 50)(body, new AbortController().signal),
        /Telemetry transport failed/,
      )
      await closeObserved
      queue.enqueue(JSON.parse(body)[0].state, 1000)
      const controller = new AbortController()
      const attempt = drainTelemetryOnce(
        queue,
        make(http.endpoint),
        () => 1000,
        controller.signal,
      )
      await ready
      controller.abort()
      assert.equal((await attempt).status, 'retained')
      assert.equal(queue.depth, 1)
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
  'redirects and URL-shaped printer data never contact another origin and retain the queued batch',
  { timeout: 5000 },
  async () => {
    let status = 301
    let targetCalls = 0
    let originCalls = 0
    const target = await listen((req, res) => {
      req.resume()
      targetCalls++
      res.end()
    })
    const origin = await listen((req, res) => {
      req.resume()
      originCalls++
      res.writeHead(status, { location: target.endpoint })
      res.end()
    })
    const directory = mkdtempSync(join(tmpdir(), 'open3d-auth-redirect-'))
    const queue = new TelemetryQueue(directory, 1000)
    try {
      const eventId = queue.enqueue(
        { ...JSON.parse(body)[0].state, printerKey: target.endpoint },
        1000,
      ).eventId
      const send = make(origin.endpoint)
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
