import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import type { Sql } from 'postgres'
import { PostgresTelemetryStore } from '../../apps/farm/server/storage/postgres-telemetry.ts'
import { createAuthenticatedTelemetrySender } from '../../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'
import type { TelemetryEvent } from '../../packages/farm-protocol/src/telemetry.ts'

/**
 * Stand-in for the event table only. A resent event matches when the stored
 * payload equals any of the forms the comparison query offers.
 */
function eventTable(): Sql {
  const rows = new Map<string, unknown>()
  const tx = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join('?')
      if (text.startsWith('INSERT INTO farm.telemetry_events')) {
        const [, , eventId, payload] = values
        if (rows.has(eventId as string)) return []
        rows.set(eventId as string, JSON.parse(JSON.stringify(payload)))
        return [{ event_id: eventId }]
      }
      if (text.includes('AS matches')) {
        const stored = rows.get(values.at(-1) as string)
        return [
          {
            matches: values
              .slice(0, -3)
              .some((form) =>
                isDeepStrictEqual(stored, JSON.parse(JSON.stringify(form))),
              ),
          },
        ]
      }
      return []
    },
    { json: (value: unknown) => value },
  )
  return {
    begin: (run: (inner: typeof tx) => Promise<void>) => run(tx),
  } as unknown as Sql
}

function printerEvent(
  state: 'idle' | 'printing',
  progress?: number,
  eventId: string = randomUUID(),
): TelemetryEvent {
  return {
    eventId,
    queuedAt: 10,
    kind: 'printer-state',
    state: {
      printerKey: 'simulator',
      state,
      observedAt: 10,
      lastJob: { outcome: 'cancelled', endedAt: 9 },
      ...(progress === undefined ? {} : { progress }),
    },
  } as TelemetryEvent
}

const scope = { farmId: randomUUID(), agentId: randomUUID() }

test('a resend treats idle without progress and idle at 0 as one observation', async () => {
  for (const [first, second] of [
    [undefined, 0],
    [0, undefined],
  ]) {
    const store = new PostgresTelemetryStore(eventTable())
    const eventId = randomUUID()
    const original = printerEvent('idle', first, eventId)
    const resent = {
      ...printerEvent('idle', second, eventId),
      ageAtSendMs: 5000,
    } as TelemetryEvent
    assert.equal(await store.commitBatch(scope, [original]), 'committed')
    assert.equal(await store.commitBatch(scope, [resent]), 'committed')
  }
})

test('a resend that changes anything else is still a conflict', async () => {
  for (const [original, changed] of [
    [printerEvent('idle'), printerEvent('idle', 0.5)],
    [printerEvent('idle', 0.5), printerEvent('idle')],
    [printerEvent('printing', 0), printerEvent('idle')],
    [printerEvent('printing', 0), printerEvent('printing', 0.5)],
  ] as const) {
    const store = new PostgresTelemetryStore(eventTable())
    assert.equal(await store.commitBatch(scope, [original]), 'committed')
    assert.equal(
      await store.commitBatch(scope, [
        { ...changed, eventId: original.eventId },
      ]),
      'conflict',
    )
  }
})

type Reply = number | 'disconnect'
type Wire = { eventId: string; state: { printerKey: string } }[]

/** Loopback telemetry server whose two steps answer as each test decides. */
async function telemetryServer(
  t: TestContext,
  answer: (step: 'challenge' | 'commit', records: Wire) => Reply,
) {
  const agentId = randomUUID(),
    farmId = randomUUID(),
    token = 'aaa.bbb.ccc',
    audience = 'fixture'
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const received: Wire[] = []
  const committed: Wire[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const records = JSON.parse(body.toString()) as Wire
    const step = req.url?.endsWith('/challenge') ? 'challenge' : 'commit'
    if (step === 'challenge') received.push(records)
    const reply = answer(step, records)
    if (reply === 'disconnect') return void res.destroy()
    res.writeHead(reply, { 'content-type': 'application/json' })
    if (reply !== 200) return void res.end('{"error":"synthetic"}')
    if (step === 'commit') {
      committed.push(records)
      return void res.end(
        JSON.stringify({
          ok: true,
          acceptedEventIds: records.map(({ eventId }) => eventId),
        }),
      )
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
          body_sha256: createHash('sha256').update(body).digest('base64url'),
          body_bytes: body.length,
        },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const directory = mkdtempSync(join(tmpdir(), 'rv-943-'))
  const queue = new TelemetryQueue(directory, Date.now())
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
    queue,
    received,
    committed,
    refused,
    enqueue: (printerKey: string) =>
      queue.enqueue(
        {
          printerKey,
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

test('a batch refused with 409 is dropped and newer batches reach the server', async (t) => {
  const server = await telemetryServer(t, (step, records) =>
    step === 'commit' &&
    records.some((record) => record.state.printerKey === 'conflicting')
      ? 409
      : 200,
  )
  // A full batch of 100, so the next record can only go in a later batch.
  for (let index = 0; index < 100; index++) server.enqueue('conflicting')
  const behind = server.enqueue('behind')

  const first = await server.drain()
  assert.equal(first.status, 'refused')
  assert.deepEqual(server.refused, [100])
  assert.equal(server.queue.depth, 1)

  const newer = server.enqueue('newer')
  assert.equal((await server.drain()).status, 'delivered')
  assert.equal(server.queue.depth, 0)
  assert.deepEqual(
    server.committed.flat().map(({ eventId }) => eventId),
    [behind, newer],
  )
  // The refused batch was offered once only.
  assert.equal(server.received.length, 2)
})

for (const [name, failing, reply] of [
  ['a server error', 'commit', 500],
  ['an unavailable server', 'commit', 503],
  ['a refused proof', 'commit', 403],
  ['a dropped connection', 'commit', 'disconnect'],
  ['a 409 before anything is compared', 'challenge', 409],
] as const) {
  test(`${name} keeps the batch for a retry`, async (t) => {
    let down = true
    const server = await telemetryServer(t, (step) =>
      down && step === failing ? reply : 200,
    )
    const eventId = server.enqueue('simulator')

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await server.drain()
      assert.equal(result.status, 'retained')
      assert.equal(result.status === 'retained' && result.reason, 'transport')
      assert.equal(server.queue.depth, 1)
    }
    down = false
    assert.equal((await server.drain()).status, 'delivered')
    assert.deepEqual(server.refused, [])
    assert.deepEqual(
      server.committed.flat().map((record) => record.eventId),
      [eventId],
    )
  })
}

test('the agent logs and counts refused batches and keeps uploading', async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'rv-943-agent-'))
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
  const now = Date.now()
  const identity = loadOrCreateIdentity(dataDirectory)
  const configPath = join(dataDirectory, 'config.json')
  const credentialPath = join(dataDirectory, 'credential.json')
  const agent = randomUUID()
  const farm = randomUUID()
  const origin = 'http://127.0.0.1:1'
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      collection: {
        version: 1,
        allowedOrigins: [origin],
        printers: [{ printerKey: 'synthetic', origin }],
      },
      assignments: [
        {
          assignment_id: randomUUID(),
          agent_id: agent,
          farm_id: farm,
          printer_key: 'synthetic',
          moonraker_origin: origin,
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
        expires_at: now + 120000,
      },
    }),
    { mode: 0o600 },
  )
  const queue = openScopedTelemetryQueue({
    dataDirectory,
    config: readAgentRuntimeConfig(
      configPath,
      readRuntimeCredential(credentialPath, identity.fingerprint, now),
    ),
    credential: readRuntimeCredential(
      credentialPath,
      identity.fingerprint,
      now,
    ),
    now,
  })
  // Two full batches to refuse, then newer records behind them.
  const eventIds = Array.from(
    { length: 250 },
    () =>
      queue.enqueue(
        {
          printerKey: 'synthetic',
          state: 'printing',
          progress: 0.5,
          observedAt: now,
        },
        now,
      ).eventId,
  )
  queue.close()

  const attempts: string[][] = []
  Object.assign(globalThis, {
    rv943Sink(body: string) {
      const ids = (JSON.parse(body) as { eventId: string }[]).map(
        ({ eventId }) => eventId,
      )
      attempts.push(ids)
      return attempts.length <= 2 ? null : ids
    },
  })
  const drainUrl = new URL(
    '../../packages/connector/src/cloud/drain.ts',
    import.meta.url,
  ).href
  // The real sender is already loaded above, so point the agent at another URL.
  const stubUrl = new URL('./rv-943-sender-stub.mjs', import.meta.url).href
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.endsWith('/cloud/authenticated-http-telemetry.ts'))
        return { url: stubUrl, shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url !== stubUrl) return next(url, context)
      return {
        format: 'module',
        shortCircuit: true,
        source: `import { TelemetryBatchRefused } from ${JSON.stringify(drainUrl)}
          export function createAuthenticatedTelemetrySender() {
            return async (body) => {
              const accepted = globalThis.rv943Sink(body)
              if (!accepted) throw new TelemetryBatchRefused()
              return accepted
            }
          }`,
      }
    },
  })
  t.after(() => {
    hooks.deregister()
    Reflect.deleteProperty(globalThis, 'rv943Sink')
  })
  const controller = new AbortController()
  const diagnostics: { kind: string }[] = []
  const { runConnectorAgent } =
    await import('../../packages/connector/src/runtime/agent.ts')
  await runConnectorAgent({
    dataDirectory,
    configPath,
    credentialPath,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    onDiagnostic(event) {
      diagnostics.push(event)
      if (event.kind === 'delivery' && event.status === 'delivered')
        controller.abort()
    },
  })

  assert.ok(controller.signal.aborted, 'a batch after the refusals arrived')
  assert.deepEqual(attempts.slice(0, 2).flat(), eventIds.slice(0, 200))
  assert.deepEqual(attempts[2]!.slice(0, 50), eventIds.slice(200))
  const counted = [
    { records: 100, total: 100 },
    { records: 100, total: 200 },
  ]
  assert.deepEqual(
    diagnostics.filter(({ kind }) => kind === 'telemetry-batch-refused'),
    counted.map((value) => ({ kind: 'telemetry-batch-refused', ...value })),
  )
  const warnings = readFileSync(join(dataDirectory, 'runtime.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { msg: string; records: number; total: number },
    )
    .filter(({ msg }) => msg === 'telemetry-batch-refused')
    .map(({ records, total }) => ({ records, total }))
  assert.deepEqual(warnings, counted)
})
