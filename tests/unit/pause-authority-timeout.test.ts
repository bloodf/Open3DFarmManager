import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import type { Sql } from 'postgres'
import {
  requirePauseTimeoutLogPath,
  validatePauseTimeoutServerReceipt,
  testPauseAuthorityTransactionTimeout,
} from '../helpers/postgres-pause-authority-timeout.ts'

const start = Date.parse('2026-01-01T00:00:00Z') / 1000
const fatal =
  '2026-01-01 00:00:10.000 UTC [42] FATAL:  25P04: terminating connection due to transaction timeout\n'
function evidence(appended = fatal) {
  return {
    pid: 42,
    dbStart: start,
    dbEnd: start + 11,
    elapsedMs: 11000,
    backendGone: true,
    beforeBytes: 100,
    afterBytes: 100 + Buffer.byteLength(appended),
    beforeDigest: 'a'.repeat(64),
    retainedDigest: 'a'.repeat(64),
    appended,
  }
}

test('accepts one complete newly appended exact backend/server timeout receipt', () => {
  assert.deepEqual(validatePauseTimeoutServerReceipt(evidence()), {
    pid: 42,
    sqlstate: '25P04',
    dbStart: start,
    dbEnd: start + 11,
    fatalEpoch: start + 10,
  })
})

test('connection loss, wrong backend and unrelated SQLSTATE cannot establish timeout', () => {
  for (const log of [
    'CONNECTION_CLOSED\n',
    fatal.replace('[42]', '[43]'),
    fatal.replace('25P04', '57014'),
  ])
    assert.throws(() => validatePauseTimeoutServerReceipt(evidence(log)))
  assert.throws(() =>
    validatePauseTimeoutServerReceipt({ ...evidence(), backendGone: false }),
  )
})

test('requires a unique FATAL in the recorded database and fixed timeout interval', () => {
  assert.throws(() =>
    validatePauseTimeoutServerReceipt(evidence(fatal + fatal)),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt({ ...evidence(), dbEnd: start + 9 }),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt(
      evidence(fatal.replace('00:00:10', '00:00:01')),
    ),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt({ ...evidence(), elapsedMs: 21000 }),
  )
})

test('fails closed for missing, rotated, truncated, incomplete or oversized log capture', () => {
  assert.throws(() => validatePauseTimeoutServerReceipt(evidence('')))
  assert.throws(() =>
    validatePauseTimeoutServerReceipt({ ...evidence(), afterBytes: 99 }),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt({
      ...evidence(),
      retainedDigest: 'b'.repeat(64),
    }),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt({ ...evidence(), afterBytes: 1000 }),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt(evidence(fatal.trimEnd())),
  )
  assert.throws(() =>
    validatePauseTimeoutServerReceipt(evidence('x'.repeat(65536) + fatal)),
  )
})

test('requires an explicit canonical server path without guessing a private fixture path', () => {
  assert.equal(
    requirePauseTimeoutLogPath('/synthetic-fixture/server.log'),
    '/synthetic-fixture/server.log',
  )
  for (const value of [
    undefined,
    '',
    'server.log',
    '/a/../server.log',
    '/server\0.log',
    '/server\n.log',
  ])
    assert.throws(() => requirePauseTimeoutLogPath(value))
})

test('runner rejects missing server-log configuration before any PostgreSQL connection', () => {
  const env = { ...process.env }
  delete env.PAUSE_AUTHORITY_SYNTHETIC_SERVER_LOG
  delete env.PAUSE_AUTHORITY_SYNTHETIC_RESTART_BASE
  const child = spawnSync(
    process.execPath,
    ['scripts/test-postgres-pause-authority.ts', 'run'],
    {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...env,
        PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE: 'yes',
        PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT: '15433',
      },
    },
  )
  assert.equal(child.status, 1)
  assert.doesNotMatch(child.stderr, /ECONNREFUSED|PostgresError/)
  assert.match(child.stderr, /ZodError|canonical task-server-log path/)
})

for (const cleanupFails of [false, true]) {
  test(`timeout role cleanup preserves setup error and attempts every release; cleanup failure=${cleanupFails}`, async () => {
    const setup = new Error('per-role setting failed'),
      cleanup = new Error('role removal failed')
    const statements: string[] = []
    const admin = ((parts: TemplateStringsArray | string) => {
      if (typeof parts === 'string') return parts
      const query = parts.join('?')
      statements.push(query)
      if (query.includes('pg_stat_file'))
        return Promise.resolve([{ size: 10, isdir: false }])
      if (query.includes('pg_read_binary_file'))
        return Promise.resolve([{ digest: 'a'.repeat(64) }])
      if (query.startsWith('ALTER ROLE')) return Promise.reject(setup)
      if (query.startsWith('DROP ROLE') && cleanupFails)
        return Promise.reject(cleanup)
      if (query.includes('count(*)')) return Promise.resolve([{ count: 0 }])
      return Promise.resolve([])
    }) as unknown as Sql
    await assert.rejects(
      testPauseAuthorityTransactionTimeout(
        admin,
        15433,
        '/synthetic-fixture/server.log',
      ),
      (error) => {
        if (!cleanupFails) return error === setup
        assert.ok(error instanceof AggregateError)
        assert.deepEqual(error.errors, [setup, cleanup])
        return true
      },
    )
    assert.ok(statements.some((query) => query.startsWith('DROP ROLE')))
    assert.ok(
      statements.at(-1)?.includes('pg_roles'),
      'Role audit still attempted after failed DROP',
    )
  })
}
