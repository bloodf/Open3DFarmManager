import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLibraryStore } from '../../packages/connector/src/runtime/library-store.ts'
import { LIBRARY_ORPHAN_GRACE_MS } from '../../packages/farm-protocol/src/library-storage.ts'

// Loopback fixture: emulate servers that reject unknown telemetry fields.
test('heartbeat fallback preserves send age and tries older shapes in order', async () => {
  const agentId = randomUUID(),
    farmId = randomUUID(),
    eventId = randomUUID()
  const token = 'aaa.bbb.ccc',
    audience = 'fixture'
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const body = JSON.stringify([
    {
      eventId,
      queuedAt: 1,
      kind: 'heartbeat',
      health: {
        connector: {
          version: '1',
          uptimeMs: 1,
          queueBacklog: 0,
          refusedRecords: 2,
          storage: 'healthy',
          rtcScope: 'disabled',
        },
        printers: [],
      },
    },
    {
      eventId: randomUUID(),
      queuedAt: 1,
      kind: 'printer-state',
      ageAtSendMs: 5678,
      state: {
        printerKey: 'simulator',
        state: 'idle',
        observedAt: 1,
        lastJob: { outcome: 'completed', endedAt: 1 },
      },
    },
  ])
  const requests: string[] = [],
    committed: string[] = [],
    signed: string[] = []
  let mode: 'count' | 'both' | 'current' = 'count'
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/challenge')) {
      requests.push(text)
      const records = JSON.parse(text)
      if (
        (mode !== 'current' &&
          records[0].health.connector.refusedRecords !== undefined) ||
        (mode === 'both' &&
          records.some(
            (record: { ageAtSendMs?: number }) =>
              record.ageAtSendMs !== undefined,
          )) ||
        records[1].state.progress === undefined
      ) {
        res.writeHead(400).end('{}')
        return
      }
      const now = Date.now()
      res.end(
        JSON.stringify({
          challenge: {
            v: 2,
            purpose: 'telemetry-ingestion',
            method: 'POST',
            path: '/api/connector/telemetry',
            agent_id: agentId,
            farm_id: farmId,
            jti: randomUUID(),
            connection_id: randomUUID(),
            public_key_spki: spki.toString('base64url'),
            fingerprint:
              'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
            thumbprint: 'A'.repeat(43),
            token_hash: createHash('sha256').update(token).digest('base64url'),
            origin: 'https://farm.example',
            audience,
            generation: 1,
            nonce: 'A'.repeat(43),
            issued_at: now,
            expires_at: now + 5000,
            body_sha256: createHash('sha256').update(text).digest('base64url'),
            body_bytes: Buffer.byteLength(text),
          },
        }),
      )
      return
    }
    committed.push(text)
    res.end(JSON.stringify({ ok: true, acceptedEventIds: [eventId] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const send = createAuthenticatedTelemetrySender({
    endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
    token,
    agentId,
    farmId,
    audience,
    timeoutMs: 5000,
    allowLoopbackHttpForTests: true,
    identity: {
      signTelemetryProof: ({ body: bytes }) => {
        signed.push(new TextDecoder().decode(bytes))
        return 'A'.repeat(86)
      },
    },
  })
  try {
    await send(body, new AbortController().signal)
    assert.equal(requests.length, 3)
    const first = JSON.parse(requests[0]!),
      progress = JSON.parse(requests[1]!),
      fallback = JSON.parse(requests[2]!)
    assert.equal(first[1].state.progress, undefined)
    assert.equal(progress[1].state.progress, 0)
    assert.equal(progress[0].health.connector.refusedRecords, 2)
    assert.equal(fallback[0].health.connector.refusedRecords, undefined)
    assert.equal(fallback[1].ageAtSendMs, 5678)
    assert.equal(signed[0], requests[2])
    assert.equal(committed[0], requests[2])

    requests.length = 0
    mode = 'both'
    await send(body, new AbortController().signal)
    assert.equal(requests.length, 5)
    assert.equal(JSON.parse(requests[3]!)[0].health.connector.refusedRecords, 2)
    assert.equal(JSON.parse(requests[3]!)[1].ageAtSendMs, undefined)
    assert.equal(
      JSON.parse(requests[4]!)[0].health.connector.refusedRecords,
      undefined,
    )
    assert.equal(JSON.parse(requests[4]!)[1].ageAtSendMs, undefined)
    assert.equal(committed[1], requests[4])

    requests.length = 0
    mode = 'current'
    await send(body, new AbortController().signal)
    assert.equal(requests[0], body)
    assert.equal(
      JSON.parse(committed[2]!)[0].health.connector.refusedRecords,
      2,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('deduplicating an old orphan renews its grace before the server records it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fix-959-library-'))
  try {
    const now = Date.now()
    const store = await createLibraryStore({ directory, clock: () => now })
    const bytes = Buffer.from('fixture gcode')
    const source = async function* () {
      yield bytes
    }
    const first = await store.put(source())
    const path = join(directory, first.sha256)
    const old = new Date(now - LIBRARY_ORPHAN_GRACE_MS - 60_000)
    await utimes(path, old, old)
    const second = await store.put(source())
    assert.equal(second.deduplicated, true)
    assert.deepEqual(await store.sweep([]), [])
    assert.ok((await stat(path)).mtimeMs > old.getTime())
    assert.equal(await store.has(first.sha256), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
