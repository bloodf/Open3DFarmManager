/**
 * #955, the low leftovers of #953: a shared SDCP history connection survives
 * one viewer leaving or failing, the count of refused telemetry records reaches
 * the farm and survives a restart, and the relay never discards a file a record
 * points at. Simulators and loopback fixtures only; no printer is contacted.
 * The production-timeout journal case is in security-regression.test.ts.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { registerHooks } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildEntries } from '../../apps/farm/app/utils/network-map.ts'
import { ConnectorLibraryRelayHub } from '../../apps/farm/server/utils/library/connector-relay.ts'
import { PostgresLibrary } from '../../apps/farm/server/utils/library/store.ts'
import { projectNetwork } from '../../apps/farm/server/utils/network-projection.ts'
import {
  drainTelemetryOnce,
  TelemetryBatchRefused,
} from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { readSdcpHistory } from '../../packages/connector/src/sdcp/history.ts'
import { TelemetryBatch } from '../../packages/farm-protocol/src/telemetry.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { printer, RESIN } from '../helpers/elegoo-safety.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'

async function until<T>(read: () => T | Promise<T>, what: string) {
  const deadline = performance.now() + 15_000
  for (;;) {
    const value = await read()
    if (value) return value
    if (performance.now() > deadline) assert.fail('Timed out: ' + what)
    await sleep(20)
  }
}

// ---- shared SDCP history connection ----------------------------------------

const TASK = {
  TaskId: 'task-1',
  TaskName: '/local/part.ctb',
  BeginTime: 100,
  EndTime: 160,
  TaskStatus: 1,
}

async function resin(t: TestContext) {
  const world = await printer(t, RESIN)
  world.machine.history = [TASK]
  const endpoint = {
    host: '127.0.0.1',
    mainboardId: 'board01',
    model: RESIN,
    discoveryPort: world.sim.discoveryPort,
    websocketPort: world.sim.websocketPort,
  }
  const closed = () =>
    until(() => world.sim.connected() === 0, 'connection closed')
  return { ...world, endpoint, closed }
}
const files = async (read: ReturnType<typeof readSdcpHistory>) =>
  (await read).map((job) => job.file)

test('the first viewer leaving does not break a read in flight', async (t) => {
  const world = await resin(t)
  const first = new AbortController()
  const second = new AbortController()
  await readSdcpHistory(world.endpoint, first.signal)
  const read = files(readSdcpHistory(world.endpoint, second.signal))
  first.abort()
  assert.deepEqual(await read, ['part.ctb'])
  assert.equal(world.sim.connected(), 1)
  second.abort()
  await world.closed()
})

test('a viewer leaving while the connection opens leaves it to the others', async (t) => {
  const world = await resin(t)
  const first = new AbortController()
  const second = new AbortController()
  const gone = readSdcpHistory(world.endpoint, first.signal)
  const read = files(readSdcpHistory(world.endpoint, second.signal))
  first.abort()
  await assert.rejects(gone)
  assert.deepEqual(await read, ['part.ctb'])
  second.abort()
  await world.closed()
})

test('a later viewer leaving mid-read does not break the others', async (t) => {
  const world = await resin(t)
  const first = new AbortController()
  const second = new AbortController()
  await readSdcpHistory(world.endpoint, first.signal)
  const read = files(readSdcpHistory(world.endpoint, first.signal))
  const gone = readSdcpHistory(world.endpoint, second.signal)
  second.abort()
  await assert.rejects(gone)
  assert.deepEqual(await read, ['part.ctb'])
  assert.equal(world.sim.connected(), 1)
  first.abort()
  await world.closed()
})

test('one failed read does not close the connection under another', async (t) => {
  const world = await resin(t)
  // Only the first list reply is malformed.
  let replies = 0
  Object.defineProperty(world.machine, 'history', {
    get: () => (replies++ === 0 ? { map: () => 'broken' } : [TASK]),
  })
  const viewer = new AbortController()
  const failed = readSdcpHistory(world.endpoint, viewer.signal)
  const read = files(readSdcpHistory(world.endpoint, viewer.signal))
  await assert.rejects(failed, /malformed/)
  assert.deepEqual(await read, ['part.ctb'])
  // The failed connection is retired once unused, and a new read reconnects.
  await world.closed()
  assert.deepEqual(
    await files(readSdcpHistory(world.endpoint, viewer.signal)),
    ['part.ctb'],
  )
  viewer.abort()
  await world.closed()
})

// ---- refused telemetry records ---------------------------------------------

const state = () => ({
  printerKey: 'printer',
  state: 'idle' as const,
  progress: 0,
  observedAt: Date.now(),
})

test('the queue keeps the refused count across restarts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-955-queue-'))
  let queue = new TelemetryQueue(directory, Date.now())
  t.after(() => {
    queue.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const restart = () => {
    queue.close()
    queue = new TelemetryQueue(directory, Date.now())
  }
  const refuse = () =>
    drainTelemetryOnce(
      queue,
      async () => {
        throw new TelemetryBatchRefused()
      },
      Date.now,
      new AbortController().signal,
      undefined,
      () => {},
    )
  queue.enqueue(state(), Date.now())
  queue.enqueue(state(), Date.now())
  assert.equal(queue.refusedRecords, 0)
  assert.equal((await refuse()).status, 'refused')
  assert.equal(queue.refusedRecords, 2)
  restart()
  assert.equal(queue.refusedRecords, 2)
  // An interrupted write of the count leaves the committed one.
  writeFileSync(join(directory, 'telemetry.refused.tmp'), '9', { mode: 0o600 })
  restart()
  queue.enqueue(state(), Date.now())
  await refuse()
  restart()
  assert.equal(queue.refusedRecords, 3)
  assert.equal(
    statSync(join(directory, 'telemetry.refused')).mode & 0o777,
    0o600,
  )
  assert.equal(readFileSync(join(directory, 'telemetry.refused'), 'utf8'), '3')
})

test('the agent reports the refused count to the farm after a restart', async (t) => {
  const moonraker = await startMoonrakerMock({
    initial: { state: 'standby' },
    maxWsConnections: 8,
  })
  const directory = mkdtempSync(join(tmpdir(), 'rv-955-agent-'))
  const cloud = {
    refuse: true,
    Refused: TelemetryBatchRefused,
    bodies: [] as string[],
  }
  Object.assign(globalThis, { rv955Cloud: cloud })
  // Replace only the cloud transport.
  const hooks = registerHooks({
    load(url, context, next) {
      if (url.endsWith('/cloud/authenticated-http-telemetry.ts'))
        return {
          format: 'module',
          shortCircuit: true,
          source: `export function createAuthenticatedTelemetrySender() {
            const cloud = globalThis.rv955Cloud
            return async (body) => {
              if (cloud.refuse) {
                cloud.refuse = false
                throw new cloud.Refused()
              }
              cloud.bodies.push(body)
              return JSON.parse(body).map((record) => record.eventId)
            }
          }`,
        }
      return next(url, context)
    },
  })
  // The heartbeat period is a minute; shorten that one timer.
  const realInterval = globalThis.setInterval
  globalThis.setInterval = ((run: () => void, ms?: number) =>
    realInterval(run, ms === 60_000 ? 100 : ms)) as typeof setInterval
  let controller = new AbortController()
  let running: Promise<unknown> | undefined
  t.after(async () => {
    controller.abort()
    await running?.catch(() => {})
    globalThis.setInterval = realInterval
    hooks.deregister()
    await moonraker.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))

  const identity = loadOrCreateIdentity(directory)
  const agent = randomUUID()
  const farm = randomUUID()
  const configPath = join(directory, 'config.json')
  const credentialPath = join(directory, 'credential.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [moonraker.origin],
        printers: [{ printerKey: 'printer', origin: moonraker.origin }],
      },
      assignments: [
        {
          assignment_id: randomUUID(),
          agent_id: agent,
          farm_id: farm,
          printer_key: 'printer',
          moonraker_origin: moonraker.origin,
        },
      ],
      telemetry: {
        endpoint: 'https://127.0.0.1:1/api/connector/telemetry',
        audience: 'fixture',
        retryMinMs: 100,
        retryMaxMs: 200,
        idleMs: 100,
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    credentialPath,
    JSON.stringify({
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval: {
        status: 'approved',
        agent_id: agent,
        farm_id: farm,
        device_token:
          'e30.' +
          Buffer.from(JSON.stringify({ jti: randomUUID() })).toString(
            'base64url',
          ) +
          '.AA',
        expires_at: Date.now() + 120_000,
      },
    }),
    { mode: 0o600 },
  )
  const { runConnectorAgent } =
    await import('../../packages/connector/src/runtime/agent.ts')
  const start = () => {
    controller = new AbortController()
    running = runConnectorAgent({
      configPath,
      credentialPath,
      dataDirectory: directory,
      statusPort: port,
      signal: controller.signal,
      onDiagnostic: () => {},
    })
  }
  const localCount = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`)
      return ((await response.json()) as { refusedRecords?: number })
        .refusedRecords
    } catch {
      return undefined
    }
  }

  start()
  const refused = await until(localCount, 'refused batch')
  controller.abort()
  await running

  cloud.bodies = []
  start()
  const heartbeat = await until(
    () =>
      cloud.bodies
        .flatMap((body) => TelemetryBatch.parse(JSON.parse(body)))
        .find((record) => record.kind === 'heartbeat'),
    'heartbeat after restart',
  )
  assert.equal(await localCount(), refused)
  assert.equal(heartbeat.health.connector.refusedRecords, refused)

  // What the farm stores is what its network view shows.
  const view = projectNetwork({
    role: 'viewer',
    connectors: [
      {
        agentId: agent,
        fingerprint: identity.fingerprint,
        status: 'approved',
        lastSeenAt: heartbeat.queuedAt,
        health: heartbeat.health,
      },
    ],
    printers: [],
    discoveries: [],
  })
  assert.equal(view.connectors[0]!.health?.refusedRecords, refused)
})

test('the network view names dropped records on the Connector only', () => {
  const now = Date.now()
  const entries = (refusedRecords?: number) =>
    buildEntries(
      {
        connectors: [
          {
            agentId: 'agent',
            fingerprint: 'print',
            status: 'approved',
            lastSeenAt: now - 120_000,
            health: {
              version: '1',
              storage: 'healthy',
              ...(refusedRecords ? { refusedRecords } : {}),
            },
          },
        ],
        printers: [
          {
            assignmentId: 'assignment',
            agentId: 'agent',
            printerKey: 'printer',
            displayName: null,
            link: null,
          },
        ],
        discovered: [],
      },
      { now },
    ).map((entry) => entry.statusText)
  assert.deepEqual(entries(), ['Sem sinal', 'Sem sinal (Connector)'])
  assert.deepEqual(entries(1), [
    'Sem sinal · 1 registro descartado',
    'Sem sinal (Connector)',
  ])
  assert.equal(entries(3)[0], 'Sem sinal · 3 registros descartados')
})

// ---- relay discard ---------------------------------------------------------

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
  'a mismatched relay upload never discards a file a record points at',
  { skip: missing || false, timeout: 120_000 },
  async (t) => {
    const database = disposablePostgres({
      ...vitestPostgresOptions('openfarm-rv-955'),
      isolated: true,
    })
    t.after(() => database.stop())
    const sql = await database.start()
    const farm = randomUUID()
    const agent = randomUUID()
    const referenced = 'a'.repeat(64)
    const unreferenced = 'b'.repeat(64)
    await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false)`
    await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint)
      VALUES (${agent}, ${farm}, ${'k'.repeat(59)}, ${agent.padEnd(50, 'f')})`
    await sql`INSERT INTO farm.library_blobs (farm_id, sha256, size_bytes, storage_location, agent_id, created_at)
      VALUES (${farm}, ${referenced}, 1, 'connector', ${agent}, ${Date.now()})`

    const identity = { farmId: farm, agentId: agent }
    const store = new PostgresLibrary(sql)
    const hub = new ConnectorLibraryRelayHub({
      authenticate: async () => identity,
      pollMs: 200,
      discardUnused: (file, discard) => store.discardUnused(file, discard),
    })
    t.after(() => hub.close())
    const headers = new Headers()
    const bytes = Buffer.from('synthetic upload')
    const actual = createHash('sha256').update(bytes).digest('hex')

    /** Uploads `bytes`, answers with `claimed` and returns what is discarded. */
    async function upload(claimed: string) {
      const refused = assert.rejects(
        hub.put({
          ...identity,
          body: Readable.from([bytes]),
          maxBytes: bytes.length,
        }),
        /integridade divergentes/,
      )
      const op = (await hub.poll(headers))!.op!
      const body = await hub.body(headers, op.op_id)
      assert.equal(body.status, 200)
      if (body.status === 200) for await (const _ of body.stream);
      const report = (opId: string, result: unknown) =>
        hub.result(
          headers,
          opId,
          'application/json',
          new Response(JSON.stringify(result)).body,
        )
      await report(op.op_id, {
        ok: true,
        type: 'put',
        sha256: claimed,
        size: bytes.length,
        created: true,
      })
      const next = (await hub.poll(headers))!.op
      if (next) await report(next.op_id, { ok: true, type: 'discard' })
      await refused
      return next
    }

    assert.notEqual(actual, referenced)
    assert.equal(await upload(referenced), null)
    const discard = await upload(unreferenced)
    assert.equal(discard?.type, 'discard')
    assert.equal(discard?.type === 'discard' && discard.sha256, unreferenced)
  },
)

test('the production relay is wired to the locked reference check', () => {
  assert.match(
    readFileSync(
      new URL(
        '../../apps/farm/server/plugins/library-relay-lifecycle.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    /discardUnused: \(file, discard\) =>\s+new PostgresLibrary\(pool\)\.discardUnused\(file, discard\)/,
  )
})
