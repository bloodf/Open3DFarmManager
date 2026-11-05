import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'

test('bounded busy retries keep proof and body, respect expiry, cancellation and malformed responses', async () => {
  const agentId = randomUUID(),
    farmId = randomUUID(),
    eventId = randomUUID(),
    token = 'aaa.bbb.ccc',
    audience = 'fixture'
  const body = JSON.stringify([
    {
      eventId,
      queuedAt: 1,
      kind: 'printer-state',
      state: { printerKey: 'sim', state: 'idle', progress: 0, observedAt: 1 },
    },
  ])
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  let mode: 'normal' | 'expiry' | 'malformed' | 'abort' | 'deadline' = 'normal'
  let issueCount = 0,
    acceptCount = 0,
    issuedAt = 0
  const attempts: string[] = []
  let abortReady: (() => void) | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), body)
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/challenge')) {
      issueCount++
      if (mode === 'normal' && issueCount <= 2) {
        res.writeHead(429)
        res.end(JSON.stringify({ error: 'busy', retryAfterMs: 1 }))
        return
      }
      issuedAt = Date.now()
      const challenge = {
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
        issued_at: issuedAt,
        expires_at: issuedAt + (mode === 'expiry' ? 50 : 5000),
        body_sha256: createHash('sha256').update(body).digest('base64url'),
        body_bytes: Buffer.byteLength(body),
      }
      res.end(JSON.stringify({ challenge }))
      return
    }
    acceptCount++
    attempts.push(
      JSON.stringify([
        req.headers['x-telemetry-challenge'],
        req.headers['x-telemetry-signature'],
      ]),
    )
    if (mode === 'malformed') {
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'busy', retryAfterMs: 0 }))
      return
    }
    if (mode === 'abort') {
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'busy', retryAfterMs: 1000 }))
      abortReady?.()
      return
    }
    if (mode === 'expiry' || mode === 'deadline') {
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'busy', retryAfterMs: 1000 }))
      return
    }
    if (Date.now() < issuedAt + 1000) {
      res.writeHead(429)
      res.end(
        JSON.stringify({
          error: 'busy',
          retryAfterMs: Math.min(500, issuedAt + 1000 - Date.now()),
        }),
      )
      return
    }
    res.end(JSON.stringify({ ok: true, acceptedEventIds: [eventId] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const make = (timeoutMs: number) =>
    createAuthenticatedTelemetrySender({
      endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
      token,
      agentId,
      farmId,
      audience,
      timeoutMs,
      allowLoopbackHttpForTests: true,
      identity: { signTelemetryProof: () => 'A'.repeat(86) },
    })
  try {
    assert.deepEqual(await make(4000)(body, new AbortController().signal), [
      eventId,
    ])
    assert.equal(issueCount, 3)
    assert.ok(acceptCount >= 3)
    assert.equal(new Set(attempts).size, 1)
    mode = 'expiry'
    await assert.rejects(make(4000)(body, new AbortController().signal))
    mode = 'malformed'
    await assert.rejects(make(4000)(body, new AbortController().signal))
    mode = 'deadline'
    await assert.rejects(make(100)(body, new AbortController().signal))
    mode = 'abort'
    const controller = new AbortController()
    const ready = new Promise<void>((resolve) => {
      abortReady = resolve
    })
    const pending = make(4000)(body, controller.signal)
    await ready
    controller.abort()
    await assert.rejects(pending)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
