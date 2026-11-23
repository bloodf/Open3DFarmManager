import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { readRuntimeCredential } from '../../packages/connector/src/config/credential.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { openScopedTelemetryQueue } from '../../packages/connector/src/runtime/queue-scope.ts'
import { parseBoundedJson } from '../../packages/farm-protocol/src/json.ts'
import {
  TELEMETRY_BATCH_JSON_LIMITS,
  TelemetryBatch,
} from '../../packages/farm-protocol/src/telemetry.ts'

const filename = 'synthetic-printer-filename-' + 'é🧵'.repeat(50)
function appendLegacyRecords(directory: string, now: number) {
  const makeRecord = (printerKey: string, name?: string) => ({
    eventId: randomUUID(),
    queuedAt: now,
    kind: 'printer-state',
    state: {
      printerKey,
      state: 'printing',
      progress: 0.4,
      ...(name ? { filename: name } : {}),
      observedAt: now,
    },
  })
  const head = makeRecord('synthetic', filename)
  const next = makeRecord('synthetic')
  // These canonical queue lines simulate an upgrade from a Connector that
  // could persist 255-unit filenames despite the tighter telemetry limit.
  appendFileSync(
    join(directory, 'telemetry.jsonl'),
    [head, next].map((event) => JSON.stringify(event) + '\n').join(''),
  )
  return { dropped: head.eventId, valid: next.eventId }
}

const ids = (body: string) =>
  TelemetryBatch.parse(parseBoundedJson(body, TELEMETRY_BATCH_JSON_LIMITS)).map(
    (event) => event.eventId,
  )

test('drain durably skips an oversized queue head and delivers the following entry', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'telemetry-drain-unencodable-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const now = 1000
  new TelemetryQueue(directory, now).close()
  const { valid } = appendLegacyRecords(directory, now)
  const signal = new AbortController().signal
  const sent: string[] = []
  let dropped = 0
  const send = async (body: string) => {
    const accepted = ids(body)
    sent.push(...accepted)
    return accepted
  }

  const queue = new TelemetryQueue(directory, now)
  try {
    assert.equal(queue.depth, 2)
    const result = await drainTelemetryOnce(
      queue,
      send,
      () => now,
      signal,
      () => dropped++,
    )
    assert.equal(result.status, 'delivered')
    assert.deepEqual(sent, [valid])
    assert.equal(dropped, 1)
    assert.equal(queue.depth, 0)
  } finally {
    queue.close()
  }
  const reopened = new TelemetryQueue(directory, now)
  try {
    assert.equal(reopened.depth, 0)
  } finally {
    reopened.close()
  }
})

test(
  'agent logs a fixed warning and delivers telemetry after an unencodable head',
  { timeout: 10000 },
  async (t) => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'telemetry-drain-agent-'))
    t.after(() => rmSync(dataDirectory, { recursive: true, force: true }))
    const now = Date.now()
    const identity = loadOrCreateIdentity(dataDirectory)
    const telemetryDirectory = join(dataDirectory, 'telemetry')
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

    const credential = readRuntimeCredential(
      credentialPath,
      identity.fingerprint,
      now,
    )
    openScopedTelemetryQueue({
      dataDirectory,
      config: readAgentRuntimeConfig(configPath, credential),
      credential,
      now,
    }).close()
    const { dropped, valid } = appendLegacyRecords(telemetryDirectory, now)

    // Replace cloud exchange with an in-memory sink. The agent still uses its
    // real scoped queue, process lifecycle, drain loop, and runtime logger.
    const sent: string[] = []
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Network disabled in test')
    })
    const sink = {
      accept(body: string) {
        const accepted = ids(body)
        sent.push(...accepted)
        return accepted
      },
    }
    Object.assign(globalThis, { telemetryDrainTestSink: sink })
    const hooks = registerHooks({
      load(url, context, next) {
        if (url.endsWith('/cloud/authenticated-http-telemetry.ts'))
          return {
            format: 'module',
            shortCircuit: true,
            source: `export function createAuthenticatedTelemetrySender() {
            return async (body) => globalThis.telemetryDrainTestSink.accept(body)
          }`,
          }
        return next(url, context)
      },
    })
    t.after(() => {
      hooks.deregister()
      Reflect.deleteProperty(globalThis, 'telemetryDrainTestSink')
    })
    const controller = new AbortController()
    const diagnostics: unknown[] = []
    const { runConnectorAgent } =
      await import('../../packages/connector/src/runtime/agent.ts')
    await runConnectorAgent({
      dataDirectory,
      configPath,
      credentialPath,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      onDiagnostic(event) {
        diagnostics.push(event)
        if (
          event.kind === 'delivery' &&
          event.status === 'delivered' &&
          sent.includes(valid)
        )
          controller.abort()
      },
    })

    assert.ok(
      controller.signal.aborted,
      'agent stopped only after the later entry was delivered',
    )
    assert.ok(!sent.includes(dropped))
    assert.deepEqual(
      diagnostics.filter(
        (event) =>
          (event as { kind: string }).kind === 'telemetry-entry-dropped',
      ),
      [{ kind: 'telemetry-entry-dropped' }],
    )
    const log = readFileSync(join(dataDirectory, 'runtime.jsonl'), 'utf8')
    assert.doesNotMatch(log, /synthetic-printer-filename/)
    const warnings = log
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            ts: string
            msg: string
          },
      )
      .filter((entry) => entry.msg === 'telemetry-entry-dropped')
    assert.deepEqual(
      warnings.map(({ ts: _timestamp, ...warning }) => warning),
      [
        {
          level: 'warn',
          name: 'connector',
          msg: 'telemetry-entry-dropped',
        },
      ],
    )
  },
)
