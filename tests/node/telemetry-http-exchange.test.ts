import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { once } from 'node:events'
import { test } from 'node:test'
import { createTelemetryHttpHandler } from '../../apps/farm/server/services/telemetry-http.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import type { PostgresConnectorCredentialAcceptance } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'

test('lost acknowledgement retries identical event bytes with a fresh challenge', async () => {
  const agentId = randomUUID(),
    farmId = randomUUID(),
    jti = randomUUID()
  const token = 'aaa.bbb.ccc',
    audience = 'synthetic-audience'
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const directory = mkdtempSync(join(tmpdir(), 'o3dfm-telemetry-http-queue-'))
  let queue = new TelemetryQueue(directory, 1000)
  const record = queue.enqueue(
    { printerKey: 'simulator', state: 'idle', progress: 0, observedAt: 1 },
    1000,
  )
  const eventId = record.eventId
  const body = JSON.stringify(queue.batch(1000, 100, 65536).records)
  let issued: Uint8Array | undefined
  let wrongAgent = false,
    redirect = false,
    redirectFollowed = false
  let challenges = 0,
    commits = 0
  const connectionIds = new Set<string>()
  let origin = ''
  const store: Pick<
    PostgresConnectorCredentialAcceptance,
    'issueTelemetryChallenge' | 'commitTelemetryWithProof'
  > = {
    async issueTelemetryChallenge(input, raw) {
      assert.ok(
        input &&
          typeof input === 'object' &&
          'connectionId' in input &&
          typeof input.connectionId === 'string',
      )
      assert.ok(raw instanceof Uint8Array)
      issued = Uint8Array.from(raw)
      challenges++
      connectionIds.add(input.connectionId)
      const now = Date.now()
      return {
        ok: true,
        kind: 'challenge',
        challenge: {
          v: 2,
          purpose: 'telemetry-ingestion',
          method: 'POST',
          path: '/api/connector/telemetry',
          agent_id: wrongAgent ? randomUUID() : agentId,
          farm_id: farmId,
          jti,
          connection_id: input.connectionId,
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
          body_sha256: createHash('sha256').update(raw).digest('base64url'),
          body_bytes: raw.length,
        },
      }
    },
    async commitTelemetryWithProof(input, raw) {
      assert.ok(issued && raw instanceof Uint8Array)
      assert.deepEqual(Buffer.from(raw), Buffer.from(issued))
      commits++
      assert.ok(input && typeof input === 'object' && 'signature' in input)
      return {
        ok: true,
        kind: 'telemetry-committed',
        acceptedEventIds: [eventId],
        jti,
        acceptedAt: Date.now(),
        expiresAt: Date.now() + 1000,
      }
    },
  }
  const handler = createTelemetryHttpHandler(store, 1000)
  const server = createServer(async (req, res) => {
    if (req.url === '/unexpected') {
      redirectFollowed = true
      res.end()
      return
    }
    if (redirect) {
      res.writeHead(302, { Location: '/unexpected' })
      res.end()
      return
    }
    const result = await handler({ '~app': { node: { req } } })
    if (req.url === '/api/connector/telemetry' && commits === 1) {
      res.destroy()
      return
    }
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result.body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  origin = `http://127.0.0.1:${address.port}`
  try {
    const send = createAuthenticatedTelemetrySender({
      endpoint: origin + '/api/connector/telemetry',
      token,
      agentId,
      farmId,
      audience,
      timeoutMs: 2000,
      allowLoopbackHttpForTests: true,
      identity: {
        signTelemetryProof(input) {
          assert.deepEqual(input.body, new TextEncoder().encode(body))
          return 'A'.repeat(86)
        },
      },
    })
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          send,
          () => 1000,
          new AbortController().signal,
        )
      ).status,
      'retained',
    )
    assert.equal(queue.depth, 1)
    queue.close()
    queue = new TelemetryQueue(directory, 1001)
    assert.equal(queue.depth, 1)
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          send,
          () => 1001,
          new AbortController().signal,
        )
      ).status,
      'delivered',
    )
    assert.equal(queue.depth, 0)
    queue.close()
    queue = new TelemetryQueue(directory, 1002)
    assert.equal(queue.depth, 0)
    assert.equal(challenges, 2)
    assert.equal(commits, 2)
    assert.equal(connectionIds.size, 2)
    wrongAgent = true
    await assert.rejects(send(body, new AbortController().signal))
    assert.equal(commits, 2)
    redirect = true
    await assert.rejects(send(body, new AbortController().signal))
    assert.equal(redirectFollowed, false)
  } finally {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
