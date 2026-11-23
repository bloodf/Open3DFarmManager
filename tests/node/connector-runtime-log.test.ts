import test from 'node:test'
import assert from 'node:assert/strict'
import { runConnectorAgent } from '../../packages/connector/src/runtime/agent.ts'
import { runSignallingLifecycle } from '../../packages/connector/src/runtime/signalling.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { createRuntimeLogger } from '../../packages/connector/src/runtime/log.ts'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function directory(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'connector-runtime-log-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('run writes JSON lifecycle events to a private file without credential paths or tokens', async (t) => {
  const dataDirectory = directory(t)
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz'
  const credentialPath = `/missing/private-credential-${secret}`
  await assert.rejects(
    runConnectorAgent({
      configPath: credentialPath,
      credentialPath,
      dataDirectory,
      signal: new AbortController().signal,
      onDiagnostic() {},
    }),
  )
  const path = join(dataDirectory, 'runtime.jsonl')
  const output = readFileSync(path, 'utf8')
  const entries = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    entries.map((entry) => entry.msg),
    ['start', 'stop'],
  )
  assert.ok(
    entries.every(
      (entry) => entry.name === 'connector' && entry.level === 'info',
    ),
  )
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.ok(!output.includes(secret) && !output.includes(credentialPath))
})

test('runtime sink redacts credential-shaped values and preserves warning counters', (t) => {
  const dataDirectory = directory(t)
  const logger = createRuntimeLogger(dataDirectory)
  logger.warn('queue-loss', {
    expired: 2,
    capacity: 3,
    credentialPath: '/private/credential.json',
    token: 'secret-token',
    detail: 'Bearer abcdefghijklmnopqrstuvwxyz',
  })
  const line = readFileSync(join(dataDirectory, 'runtime.jsonl'), 'utf8')
  const entry = JSON.parse(line)
  assert.equal(entry.level, 'warn')
  assert.equal(entry.expired, 2)
  assert.equal(entry.capacity, 3)
  assert.equal(entry.credentialPath, '[REDACTED]')
  assert.equal(entry.token, '[REDACTED]')
  assert.doesNotMatch(
    line,
    /secret-token|\/private\/credential|abcdefghijklmnopqrstuvwxyz/,
  )
})

test('runtime logging tolerates unavailable storage and refuses symlinks', (t) => {
  const dataDirectory = directory(t)
  assert.doesNotThrow(() =>
    createRuntimeLogger(join(dataDirectory, 'missing')).info('start'),
  )
  const target = join(dataDirectory, 'credential.json')
  writeFileSync(target, 'untouched', { mode: 0o600 })
  symlinkSync(target, join(dataDirectory, 'runtime.jsonl'))
  assert.doesNotThrow(() =>
    createRuntimeLogger(dataDirectory).warn('storage-degraded'),
  )
  assert.equal(readFileSync(target, 'utf8'), 'untouched')
})

test('signalling reports a reconnect only when another attempt is due', async () => {
  const controller = new AbortController()
  let sessions = 0,
    reconnects = 0
  await runSignallingLifecycle({
    signal: controller.signal,
    credentialExpiresAt: Date.now() + 60_000,
    retryMinMs: 1,
    retryMaxMs: 1,
    sleep: async () => {},
    onReconnect() {
      reconnects++
    },
    createSession(terminal) {
      sessions++
      return {
        async start() {
          if (sessions === 2) controller.abort()
          else terminal()
        },
        close() {},
        async dispose() {},
      }
    },
  })
  assert.equal(sessions, 2)
  assert.equal(reconnects, 1)
})

test('collection reports real recovery losses as JSON warnings without opening a connection', async (t) => {
  const dataDirectory = directory(t)
  const queueDirectory = join(dataDirectory, 'queue')
  const initial = new TelemetryQueue(queueDirectory, Date.now())
  initial.close()
  // An interrupted append is a recoverable queue loss.
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(queueDirectory, 'telemetry.jsonl'), '{')
  const queue = new TelemetryQueue(queueDirectory, Date.now())
  try {
    const logger = createRuntimeLogger(dataDirectory)
    await collectIntoQueue({
      config: parseLocalCollectorConfig({
        version: 1,
        allowedOrigins: ['http://127.0.0.1:1'],
        printers: [{ printerKey: 'fixture', origin: 'http://127.0.0.1:1' }],
      }),
      queue,
      signal: AbortSignal.abort(),
      onDiagnostic() {},
      onLoss: (value) => logger.warn('queue-loss', { ...value }),
    })
    const entry = JSON.parse(
      readFileSync(join(dataDirectory, 'runtime.jsonl'), 'utf8'),
    )
    assert.equal(entry.msg, 'queue-loss')
    assert.equal(entry.level, 'warn')
    assert.equal(entry.phase, 'recovery')
    assert.equal(entry.partialTail, true)
    assert.equal(entry.expired, 0)
    assert.equal(entry.capacity, 0)
  } finally {
    queue.close()
  }
})
