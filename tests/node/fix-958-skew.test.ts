/**
 * #958: the heartbeat's refused-record count must not hold up telemetry across
 * a Connector and server version skew. Loopback fixtures only; no printer is
 * contacted.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { buildEntries } from '../../apps/farm/app/utils/network-map.ts'
import {
  lockLibraryBlob,
  runLibraryRetention,
} from '../../apps/farm/server/utils/library/retention.ts'
import { PostgresLibrary } from '../../apps/farm/server/utils/library/store.ts'
import { createTelemetryHttpHandler } from '../../apps/farm/server/services/telemetry-http.ts'
import { prepareTelemetryOperation } from '../../apps/farm/server/services/telemetry-operation.ts'
import type { PostgresConnectorCredentialAcceptance } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import { PostgresTelemetryStore } from '../../apps/farm/server/storage/postgres-telemetry.ts'
import { projectNetwork } from '../../apps/farm/server/utils/network-projection.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import {
  drainTelemetryOnce,
  TelemetryBatchRefused,
  type TelemetrySender,
} from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import {
  HeartbeatHealth,
  TelemetryBatch,
  TelemetryEvent,
} from '../../packages/farm-protocol/src/telemetry.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { RESIN } from '../helpers/elegoo-safety.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

/**
 * The server schema before #955. Since then `telemetry.ts` gained only
 * `health.connector.refusedRecords`, so every other constraint is the real one.
 */
const { refusedRecords: _added, ...oldConnector } =
  HeartbeatHealth.shape.connector.shape
const OldHealth = z.strictObject({
  ...HeartbeatHealth.shape,
  connector: z.strictObject(oldConnector),
})
const OldHeartbeat = z.strictObject({
  eventId: z.uuidv4(),
  queuedAt: z.number().int().nonnegative(),
  kind: z.literal('heartbeat'),
  health: OldHealth,
})
const OldBatch = z
  .array(
    z.union([
      OldHeartbeat,
      ...TelemetryEvent.options.filter(
        (option) => option.shape.kind.value !== 'heartbeat',
      ),
    ]),
  )
  .min(1)
  .max(100)

const health = (refusedRecords?: number): HeartbeatHealth => ({
  connector: {
    version: '1',
    uptimeMs: 1,
    queueBacklog: 0,
    ...(refusedRecords ? { refusedRecords } : {}),
    storage: 'healthy',
    rtcScope: 'disabled',
  },
  printers: [],
})
const state = {
  printerKey: 'simulator',
  state: 'printing' as const,
  progress: 0.5,
  observedAt: 1000,
}

/** The real HTTP handler over a server schema that can be upgraded in place. */
async function farm(t: TestContext, older: boolean) {
  const agentId = randomUUID()
  const farmId = randomUUID()
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const server = { older, requests: [] as string[], committed: [] as string[] }
  const parse = (raw: unknown) => {
    assert.ok(raw instanceof Uint8Array)
    const text = new TextDecoder().decode(raw)
    try {
      if (server.older) OldBatch.parse(JSON.parse(text))
      return { text, records: prepareTelemetryOperation(raw).records }
    } catch {
      return { text, records: null }
    }
  }
  const store: Pick<
    PostgresConnectorCredentialAcceptance,
    'issueTelemetryChallenge' | 'commitTelemetryWithProof'
  > = {
    async issueTelemetryChallenge(input, raw) {
      const { text, records } = parse(raw)
      server.requests.push(text)
      if (!records) return { ok: false, reason: 'invalid-input' }
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
      server.committed.push(text)
      return {
        ok: true,
        kind: 'telemetry-committed',
        acceptedEventIds: records.map((record) => record.eventId),
        jti: randomUUID(),
        acceptedAt: Date.now(),
        expiresAt: Date.now() + 1000,
      }
    },
  }
  const handler = createTelemetryHttpHandler(store, 1000)
  const http = createServer(async (req, res) => {
    const result = await handler({ '~app': { node: { req } } })
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(result.body))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  t.after(() => {
    http.closeAllConnections()
    http.close()
  })
  const address = http.address()
  assert.ok(address && typeof address !== 'string')
  const send = createAuthenticatedTelemetrySender({
    endpoint: `http://127.0.0.1:${address.port}/api/connector/telemetry`,
    token: 'aaa.bbb.ccc',
    agentId,
    farmId,
    audience: 'synthetic-audience',
    timeoutMs: 2000,
    allowLoopbackHttpForTests: true,
    identity: { signTelemetryProof: () => 'A'.repeat(86) },
  })
  return { server, send }
}

const drain = (queue: TelemetryQueue, send: TelemetrySender) =>
  drainTelemetryOnce(
    queue,
    send,
    () => 3000,
    new AbortController().signal,
    undefined,
    () => {},
  )

/** A queue that has had one record refused, so heartbeats carry a count. */
async function refusedQueue(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fix-958-'))
  const queue = new TelemetryQueue(directory, 1000)
  t.after(() => {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  })
  queue.enqueue(state, 1000)
  await drain(queue, async () => {
    throw new TelemetryBatchRefused()
  })
  assert.equal(queue.refusedRecords, 1)
  return queue
}

const committedHeartbeat = (body: string) => {
  const [record] = TelemetryBatch.parse(JSON.parse(body))
  assert.ok(record?.kind === 'heartbeat')
  return record
}

/** The count the network view shows for a stored heartbeat. */
function shown(stored: HeartbeatHealth) {
  const view = projectNetwork({
    role: 'viewer',
    connectors: [
      {
        agentId: 'agent',
        fingerprint: 'print',
        status: 'approved',
        lastSeenAt: 3000,
        health: stored,
      },
    ],
    printers: [],
    discoveries: [],
  })
  const text = buildEntries(
    {
      connectors: view.connectors,
      printers: [
        {
          assignmentId: 'assignment',
          agentId: 'agent',
          printerKey: 'simulator',
          displayName: null,
          link: null,
        },
      ],
      discovered: [],
    },
    { now: 3000 },
  )[0]!.statusText
  return { count: view.connectors[0]!.health?.refusedRecords, text }
}

test('new Connector to old server: the heartbeat is accepted and nothing waits behind it', async (t) => {
  const { server, send } = await farm(t, true)
  const queue = await refusedQueue(t)
  queue.enqueueHeartbeat(health(queue.refusedRecords), 3000)
  queue.enqueue({ ...state, observedAt: 3000 }, 3000)

  assert.equal((await drain(queue, send)).status, 'delivered')
  assert.equal(server.requests.length, 2)
  assert.match(server.requests[0]!, /"refusedRecords":1/)
  assert.doesNotMatch(server.committed[0]!, /refusedRecords/)
  assert.ok(OldBatch.safeParse(JSON.parse(server.committed[0]!)).success)
  // The telemetry queued behind the heartbeat drains next.
  assert.equal((await drain(queue, send)).status, 'delivered')
  assert.equal(queue.depth, 0)
  assert.match(server.committed[1]!, /"printer-state"/)
  // The count is kept, and the upgraded server gets it with no restart.
  assert.equal(queue.refusedRecords, 1)
  server.older = false
  queue.enqueueHeartbeat(health(queue.refusedRecords), 3000)
  assert.equal((await drain(queue, send)).status, 'delivered')
  assert.equal(
    committedHeartbeat(server.committed[2]!).health.connector.refusedRecords,
    1,
  )
})

test('old Connector to new server: a heartbeat without the count is accepted', async (t) => {
  const { server, send } = await farm(t, false)
  const record = {
    eventId: randomUUID(),
    queuedAt: 3000,
    kind: 'heartbeat',
    health: health(),
  }
  OldHeartbeat.parse(record)
  assert.deepEqual(
    await send(JSON.stringify([record]), new AbortController().signal),
    [record.eventId],
  )
  assert.equal(server.requests.length, 1)
  const stored = committedHeartbeat(server.committed[0]!).health
  assert.equal(
    HeartbeatHealth.parse(stored).connector.refusedRecords,
    undefined,
  )
  const view = shown(stored)
  assert.equal(view.count, undefined)
  assert.doesNotMatch(view.text, /descartado/)
})

test('new Connector to new server: the count arrives at once and is shown', async (t) => {
  const { server, send } = await farm(t, false)
  const queue = await refusedQueue(t)
  queue.enqueueHeartbeat(health(queue.refusedRecords), 3000)

  assert.equal((await drain(queue, send)).status, 'delivered')
  assert.equal(server.requests.length, 1)
  const stored = committedHeartbeat(server.committed[0]!).health
  const view = shown(stored)
  assert.equal(view.count, 1)
  assert.match(view.text, /1 registro descartado/)
})

// ---- the refused count -----------------------------------------------------

const DAY = 86_400_000

const queueDirectory = () => mkdtempSync(join(tmpdir(), 'fix-958-count-'))
const remove = (directory: string) =>
  rmSync(directory, { recursive: true, force: true })
async function refuseOne(queue: TelemetryQueue, now: number) {
  queue.enqueue({ ...state, observedAt: now }, now)
  await drainTelemetryOnce(
    queue,
    async () => {
      throw new TelemetryBatchRefused()
    },
    () => now,
    new AbortController().signal,
    undefined,
    () => {},
  )
}

test('the refused count clears a day after the last refusal', async (t) => {
  const directory = queueDirectory()
  const start = 1_700_000_000_000
  let queue = new TelemetryQueue(directory, start)
  t.after(() => {
    queue.close()
    remove(directory)
  })
  const restart = (now: number) => {
    queue.close()
    queue = new TelemetryQueue(directory, now)
  }
  await refuseOne(queue, start)
  // A later refusal restarts the window, and a restart keeps it.
  await refuseOne(queue, start + DAY - 1)
  assert.equal(queue.refusedRecords, 2)
  restart(start + 2 * DAY - 2)
  assert.equal(queue.refusedRecords, 2)
  queue.batch(start + 2 * DAY - 1)
  assert.equal(queue.refusedRecords, 0)
  restart(start + 2 * DAY)
  assert.equal(queue.refusedRecords, 0)
  await refuseOne(queue, start + 2 * DAY)
  assert.equal(queue.refusedRecords, 1)
})

test('a damaged count file resets to zero, logs and still opens', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  for (const damaged of ['', 'x1', '9'.repeat(65)]) {
    const directory = queueDirectory()
    t.after(() => remove(directory))
    const file = join(directory, 'telemetry.refused')
    writeFileSync(file, damaged, { mode: 0o600 })
    const queue = new TelemetryQueue(directory, Date.now())
    try {
      assert.equal(queue.refusedRecords, 0)
      assert.equal(existsSync(file), false)
      await refuseOne(queue, Date.now())
      assert.equal(readFileSync(file, 'utf8'), '1')
    } finally {
      queue.close()
    }
  }
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments[0]),
    Array(3).fill('telemetry-refused-count-reset'),
  )
})

// ---- SDCP history connections ----------------------------------------------

test('retired connections still being read count toward the cap', async (t) => {
  type Reply = {
    resolve(value: object): void
    reject(error: Error): void
  }
  const replies: Reply[] = []
  let open = 0
  Object.assign(globalThis, {
    fix958Session: async () => {
      open++
      return {
        connected: true,
        onClose() {},
        close: () => void open--,
        request: () =>
          new Promise((resolve, reject) => replies.push({ resolve, reject })),
      }
    },
  })
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier === './session.ts' &&
        context.parentURL?.endsWith('/sdcp/history.ts')
      )
        return {
          url:
            'data:text/javascript,' +
            encodeURIComponent(
              'export const openSdcpSession = (...a) => globalThis.fix958Session(...a)',
            ),
          shortCircuit: true,
        }
      return next(specifier, context)
    },
  })
  t.after(() => hooks.deregister())
  const { readSdcpHistory } =
    await import('../../packages/connector/src/sdcp/history.ts')
  const viewer = new AbortController()
  t.after(() => viewer.abort())
  const read = (board: number) =>
    readSdcpHistory(
      { host: '127.0.0.1', mainboardId: `board${board}`, model: RESIN },
      viewer.signal,
    )
  const requested = async (count: number) => {
    while (replies.length < count) await sleep(1)
  }
  const reading: Promise<unknown>[] = []
  for (let board = 0; board < 32; board++) {
    reading.push(read(board))
    await requested(2 * board + 1)
    const failing = assert.rejects(read(board), /broken/)
    await requested(2 * board + 2)
    replies.at(-1)!.reject(new Error('broken'))
    await failing
  }
  assert.equal(open, 32)
  // An accepted read would never settle, so give the refusal a bounded wait.
  await assert.rejects(
    Promise.race([read(32), sleep(500)]),
    /Too many SDCP history sessions/,
  )
  // The last read of a retired connection frees its place.
  replies[0]!.resolve({ Ack: 0, HistoryData: [] })
  await reading[0]
  assert.equal(open, 31)
  const next = read(32)
  await requested(65)
  replies.at(-1)!.resolve({ Ack: 0, HistoryData: [] })
  assert.deepEqual(await next, [])
  for (let board = 1; board < 32; board++)
    replies[2 * board]!.resolve({ Ack: 0, HistoryData: [] })
  await Promise.all(reading)
})

let missing = ''
if (process.env.OPENFARM_PG !== 'docker') {
  try {
    findPostgresBin()
  } catch (error) {
    missing = String(error)
  }
}
if (missing && process.env.CI) throw new Error(missing)

test(
  'a resend with the count after a server upgrade is not a conflict',
  { skip: missing || false, timeout: 120_000 },
  async (t) => {
    const database = disposablePostgres({
      ...vitestPostgresOptions('openfarm-fix-958'),
      isolated: true,
    })
    t.after(() => database.stop())
    const sql = await database.start()
    const scope = { farmId: randomUUID(), agentId: randomUUID() }
    await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${scope.farmId}, false)`
    await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
      VALUES (${scope.agentId}, ${scope.farmId}, ${'k'.repeat(59)}, ${scope.agentId.padEnd(50, 'f')})`
    const store = new PostgresTelemetryStore(sql)
    const event = {
      eventId: randomUUID(),
      queuedAt: 3000,
      kind: 'heartbeat' as const,
    }
    const commit = (value: HeartbeatHealth) =>
      store.commitBatch(scope, [{ ...event, health: value }])

    assert.equal(await commit(health()), 'committed')
    assert.equal(await commit(health(1)), 'committed')
    // Any other difference is still a conflict.
    const changed = health(1)
    changed.connector.uptimeMs = 2
    assert.equal(await commit(changed), 'conflict')
  },
)

test(
  'library cleanup fails fast under held locks and sweeps every reporting host',
  { skip: missing || false, timeout: 120_000 },
  async (t) => {
    const database = disposablePostgres({
      ...vitestPostgresOptions('openfarm-fix-958-library'),
      isolated: true,
    })
    t.after(() => database.stop())
    const sql = await database.start()
    const farmId = randomUUID()
    const sha256 = 'a'.repeat(64)
    await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}, false)`

    // A relay upload made by a caller that holds the upload locks.
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'library:' + farmId}, 0))`
      await lockLibraryBlob(tx as unknown as typeof sql, sha256)
      const started = performance.now()
      await assert.rejects(
        new PostgresLibrary(sql).discardUnused(
          { farmId, sha256, agentId: randomUUID() },
          async () => assert.fail('must not discard under another lock'),
        ),
        { code: '55P03' },
      )
      assert.ok(performance.now() - started < 1500)
    })

    // Neither host has a blob row; one of them is unreachable.
    const hosts = [randomUUID(), randomUUID()]
    for (const agentId of hosts)
      await sql`INSERT INTO farm.library_connector_storage (farm_id, agent_id, quota_bytes, used_bytes, reported_at)
        VALUES (${farmId}, ${agentId}, 10, 1, 1)`
    const swept: [string, readonly string[]][] = []
    const result = await runLibraryRetention(
      {
        sql,
        connectors: {
          purge: async () => [],
          sweep: async (agentId, referenced) => {
            swept.push([agentId, referenced])
            if (swept.length === 1) throw new Error('offline')
            return [sha256]
          },
        },
      },
      { batchSize: 10 },
    )
    assert.deepEqual(swept.map(([agentId]) => agentId).sort(), hosts.sort())
    assert.deepEqual(swept[0]![1], [])
    assert.equal(result.failed, 1)
  },
)
