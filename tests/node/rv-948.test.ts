/**
 * #948: a 409 names the conflicting records and the Connector drops only those.
 * Loopback only; no printer is involved and no command is sent.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createTelemetryHttpHandler } from '../../apps/farm/server/services/telemetry-http.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import {
  openLocalStatus,
  projectStatus,
} from '../../packages/connector/src/status/local.ts'

type Wire = { eventId: string }[]
type Store = Parameters<typeof createTelemetryHttpHandler>[0]

/**
 * Loopback server running the real telemetry HTTP handler. Its store refuses
 * every commit that `conflict` names records for.
 */
async function refusingServer(
  t: TestContext,
  conflict: (records: Wire) => string[] | undefined,
) {
  const agentId = randomUUID(),
    farmId = randomUUID(),
    token = 'aaa.bbb.ccc',
    audience = 'fixture'
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const committed: string[] = []
  const answers: { status: number; body: object }[] = []
  const store: Store = {
    async issueTelemetryChallenge(_input, body) {
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
          body_sha256: createHash('sha256')
            .update(body as Buffer)
            .digest('base64url'),
          body_bytes: (body as Buffer).length,
        },
      }
    },
    async commitTelemetryWithProof(_input, body) {
      const records = JSON.parse((body as Buffer).toString()) as Wire
      const named = conflict(records)
      if (named)
        return { ok: false, reason: 'conflict', conflictingEventIds: named }
      const ids = records.map(({ eventId }) => eventId)
      committed.push(...ids)
      return {
        ok: true,
        kind: 'telemetry-committed',
        acceptedEventIds: ids,
        jti: randomUUID(),
        acceptedAt: Date.now(),
        expiresAt: Date.now() + 5000,
      }
    },
  }
  const handler = createTelemetryHttpHandler(store, 1000)
  const server = createServer(async (req, res) => {
    const response = await handler({ '~app': { node: { req } } })
    answers.push(response)
    res
      .writeHead(response.status, { 'content-type': 'application/json' })
      .end(JSON.stringify(response.body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const directory = mkdtempSync(join(tmpdir(), 'rv-948-'))
  let queue = new TelemetryQueue(directory, Date.now())
  t.after(() => {
    server.closeAllConnections()
    server.close()
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const send = createAuthenticatedTelemetrySender({
    endpoint: `http://127.0.0.1:${port}/api/connector/telemetry`,
    token,
    agentId,
    farmId,
    audience,
    timeoutMs: 5000,
    allowLoopbackHttpForTests: true,
    identity: { signTelemetryProof: () => 'A'.repeat(86) },
  })
  const refused: number[] = []
  return {
    answers,
    committed,
    refused,
    get queue() {
      return queue
    },
    restart() {
      queue.close()
      queue = new TelemetryQueue(directory, Date.now())
    },
    enqueue: () =>
      queue.enqueue(
        {
          printerKey: 'simulator',
          state: 'printing',
          progress: 0.5,
          observedAt: Date.now(),
        },
        Date.now(),
      ).eventId,
    drain: () =>
      drainTelemetryOnce(
        queue,
        send,
        Date.now,
        new AbortController().signal,
        undefined,
        (records) => refused.push(records),
      ),
  }
}

test('a 409 that names records drops only those and delivers the rest', async (t) => {
  const conflicting = new Set<string>()
  const server = await refusingServer(t, (records) => {
    const named = records
      .map(({ eventId }) => eventId)
      .filter((id) => conflicting.has(id))
    return named.length ? named : undefined
  })
  const ids = Array.from({ length: 100 }, () => server.enqueue())
  // Neither is at the head of the queue.
  conflicting.add(ids[1]!)
  conflicting.add(ids[98]!)
  const kept = ids.filter((id) => !conflicting.has(id))

  const first = await server.drain()
  assert.equal(first.status, 'refused')
  const refusal = server.answers.find(({ status }) => status === 409)
  assert.deepEqual(
    (refusal?.body as { conflictingEventIds: string[] }).conflictingEventIds,
    [ids[1], ids[98]],
  )
  assert.deepEqual(server.refused, [2])
  assert.equal(server.queue.depth, 98)
  // The removal is on disk: a restart does not bring the records back.
  server.restart()
  assert.equal(server.queue.depth, 98)

  assert.equal((await server.drain()).status, 'delivered')
  assert.deepEqual(server.committed, kept)
  assert.equal(server.queue.depth, 0)

  // The count reaches the local status, both as JSON and on the page.
  const total = server.refused.reduce((sum, records) => sum + records, 0)
  const read = () => ({
    queueDepth: 0,
    delivered: kept.length,
    retries: 0,
    credentialExpired: false,
    refusedRecords: total,
  })
  assert.equal(projectStatus(read()).refusedRecords, 2)
  assert.equal(
    'refusedRecords' in projectStatus({ ...read(), refusedRecords: 0 }),
    false,
  )
  const reserved = createServer().listen(0, '127.0.0.1')
  await once(reserved, 'listening')
  const { port } = reserved.address() as { port: number }
  reserved.close()
  await once(reserved, 'close')
  const status = await openLocalStatus({ port, read, onError: assert.ifError })
  t.after(() => status.close())
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text()
  assert.match(
    page,
    /Registros descartados por conflito no servidor<\/dt><dd>2<\/dd>/,
  )
})

for (const [name, answer] of [
  ['no record', []],
  ['only unknown records', [randomUUID()]],
] as const) {
  test(`a 409 that names ${name} still drops the whole batch`, async (t) => {
    const server = await refusingServer(t, () => [...answer])
    for (let index = 0; index < 3; index++) server.enqueue()
    assert.equal((await server.drain()).status, 'refused')
    assert.deepEqual(server.refused, [3])
    assert.equal(server.queue.depth, 0)
  })
}
