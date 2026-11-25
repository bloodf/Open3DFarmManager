import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import {
  TelemetryBatch,
  TelemetryEvent,
} from '../../packages/farm-protocol/src/telemetry.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createTelemetryHttpHandler } from '../../apps/farm/server/services/telemetry-http.ts'
import { freshAdvertisedActions } from '../../apps/farm/server/storage/postgres-pause-authority.ts'
import type { PostgresConnectorCredentialAcceptance } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import { OBSERVATION_FRESH_MS } from '../../apps/farm/server/utils/integration-telemetry.ts'

const printer = {
  printerKey: 'simulator',
  state: 'printing' as const,
  progress: 0.5,
  observedAt: 1000,
}

test('old Connector to new server: records without an age keep stop actions', () => {
  const [record] = TelemetryBatch.parse([
    {
      eventId: randomUUID(),
      queuedAt: 1,
      kind: 'printer-state',
      state: printer,
    },
  ])
  assert.ok(record?.kind === 'printer-state')
  assert.equal(record.ageAtSendMs, undefined)

  const now = 10_000_000
  const controls = [
    'pause',
    'cancel',
    'emergency_stop',
    'start_print',
    'start_library_print',
    'queue_op',
  ]
  const stop = ['pause', 'cancel', 'emergency_stop']
  const grant = (age: unknown, received: number, observed?: number) =>
    freshAdvertisedActions(controls, age, received, now, observed)

  // SQL NULL is what the server stores for a record without an age.
  assert.deepEqual(grant(null, now, now), stop)
  assert.deepEqual(grant(undefined, now, now), stop)
  const oldest = now - OBSERVATION_FRESH_MS
  assert.deepEqual(grant(null, oldest, oldest), stop)
  assert.deepEqual(grant(null, oldest - 1, oldest - 1), stop)
  // A Connector clock behind the server does not take the stop actions away.
  assert.deepEqual(grant(null, now, now - 3_600_000), stop)
  // Bounded skew: an observation far ahead of its receipt is not current.
  assert.deepEqual(grant(null, now, now + 30_000), stop)
  assert.deepEqual(grant(null, now, now + 30_001), [])
  assert.deepEqual(grant(null, now, undefined), [])
  assert.deepEqual(grant(null, now + 1, now), [])
  assert.deepEqual(grant(-1, now, now), [])
  assert.deepEqual(grant('0', now, now), [])
  // With an age, job starts are available again.
  assert.deepEqual(grant(0, now, now), [
    'pause',
    'cancel',
    'emergency_stop',
    'start_print',
    'start_library_print',
    'queue_op',
  ])
})

/** The telemetry schema before `ageAtSendMs`: the same strict objects without it. */
const OldTelemetryBatch = z
  .array(
    z.union(
      TelemetryEvent.options.map((option) =>
        z.strictObject(
          Object.fromEntries(
            Object.entries(option.shape).filter(
              ([key]) => key !== 'ageAtSendMs',
            ),
          ),
        ),
      ),
    ),
  )
  .min(1)
  .max(100)

async function olderServer() {
  const agentId = randomUUID(),
    farmId = randomUUID()
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const requests: string[] = []
  const committed: string[] = []
  const signed: string[] = []
  let issued = ''
  const parse = (raw: unknown) => {
    assert.ok(raw instanceof Uint8Array)
    const text = new TextDecoder().decode(raw)
    const result = OldTelemetryBatch.safeParse(JSON.parse(text))
    return { text, records: result.success ? result.data : null }
  }
  const store: Pick<
    PostgresConnectorCredentialAcceptance,
    'issueTelemetryChallenge' | 'commitTelemetryWithProof'
  > = {
    async issueTelemetryChallenge(input, raw) {
      const { text, records } = parse(raw)
      requests.push(text)
      if (!records) return { ok: false, reason: 'invalid-input' }
      issued = text
      const now = Date.now()
      return {
        ok: true,
        kind: 'challenge',
        challenge: {
          v: 2,
          purpose: 'telemetry-ingestion',
          method: 'POST',
          path: '/api/connector/telemetry',
          agent_id: agentId,
          farm_id: farmId,
          jti: randomUUID(),
          connection_id: (input as { connectionId: string }).connectionId,
          public_key_spki: spki.toString('base64url'),
          fingerprint:
            'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
          thumbprint: 'A'.repeat(43),
          token_hash: 'A'.repeat(43),
          origin: 'https://farm.example',
          audience: 'synthetic-audience',
          generation: 1,
          nonce: 'A'.repeat(43),
          issued_at: now,
          expires_at: now + 5000,
          body_sha256: createHash('sha256').update(text).digest('base64url'),
          body_bytes: Buffer.byteLength(text),
        },
      }
    },
    async commitTelemetryWithProof(_input, raw) {
      const { text, records } = parse(raw)
      assert.ok(records)
      assert.equal(text, issued)
      committed.push(text)
      return {
        ok: true,
        kind: 'telemetry-committed',
        acceptedEventIds: records.map(
          (record) => (record as { eventId: string }).eventId,
        ),
        jti: randomUUID(),
        acceptedAt: Date.now(),
        expiresAt: Date.now() + 1000,
      }
    },
  }
  const handler = createTelemetryHttpHandler(store, 1000)
  const server = createServer(async (req, res) => {
    const result = await handler({ '~app': { node: { req } } })
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result.body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const send = createAuthenticatedTelemetrySender({
    endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
    token: 'aaa.bbb.ccc',
    agentId,
    farmId,
    audience: 'synthetic-audience',
    timeoutMs: 2000,
    allowLoopbackHttpForTests: true,
    identity: {
      signTelemetryProof(input) {
        signed.push(new TextDecoder().decode(input.body))
        return 'A'.repeat(86)
      },
    },
  })
  const close = () => {
    server.closeAllConnections()
    server.close()
  }
  return { send, close, requests, committed, signed }
}

test('new Connector to old schema: the batch drains without the age', async (t) => {
  const server = await olderServer()
  const directory = mkdtempSync(join(tmpdir(), 'rv-903-'))
  const queue = new TelemetryQueue(directory, 1000)
  t.after(() => {
    server.close()
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  })
  queue.enqueue(printer, 1000)
  queue.enqueueInventory(
    { observedAt: 1000, stale: false, total: 0, spools: [] },
    1000,
  )

  // Each batch tries the age first, so an upgraded server gets it at once.
  for (const round of [1, 2]) {
    if (round === 2) queue.enqueue({ ...printer, observedAt: 3000 }, 3000)
    const result = await drainTelemetryOnce(
      queue,
      server.send,
      () => 3000,
      new AbortController().signal,
    )
    assert.equal(result.status, 'delivered')
    assert.equal(queue.depth, 0)
    assert.equal(server.requests.length, round * 2)
    assert.match(server.requests.at(-2)!, /"ageAtSendMs"/)
    assert.doesNotMatch(server.committed.at(-1)!, /ageAtSendMs/)
    assert.equal(server.signed.at(-1), server.committed.at(-1))
  }
})

test('a refused batch with no age is not sent again', async (t) => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end('{"error":"recusado"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const send = createAuthenticatedTelemetrySender({
    endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
    token: 'aaa.bbb.ccc',
    agentId: randomUUID(),
    farmId: randomUUID(),
    audience: 'synthetic-audience',
    timeoutMs: 2000,
    allowLoopbackHttpForTests: true,
    identity: { signTelemetryProof: () => assert.fail('must not sign') },
  })
  const record = {
    eventId: randomUUID(),
    queuedAt: 1,
    kind: 'printer-state',
    state: printer,
  }
  const signal = new AbortController().signal
  await assert.rejects(send(JSON.stringify([record]), signal))
  assert.equal(requests, 1)
  // With an age there is exactly one fallback, then the failure is reported.
  await assert.rejects(
    send(JSON.stringify([{ ...record, ageAtSendMs: 1 }]), signal),
  )
  assert.equal(requests, 3)
})
