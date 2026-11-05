import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import {
  PostgresSignallingAuthorization,
  SIGNALLING_IDLE_TIMEOUT_MS,
} from '../../apps/farm/server/storage/postgres-signalling-authorization.ts'

test('passive reader rejects any idle policy differing from its reviewed SQL capability', async () => {
  const sql = postgres({ host: '127.0.0.1', port: 1, max: 1 }) // Lazy; constructor validation must issue no query.
  const config = {
    issuer: 'test-issuer',
    audience: 'test-audience',
    origin: 'https://farm.example',
    idleTimeoutMs: SIGNALLING_IDLE_TIMEOUT_MS,
  }
  try {
    assert.doesNotThrow(() => new PostgresSignallingAuthorization(sql, config))
    for (const idleTimeoutMs of [1, 1799999, 1800001, 0, -1, NaN, '1800000'])
      assert.throws(
        () =>
          new PostgresSignallingAuthorization(sql, {
            ...config,
            idleTimeoutMs,
          }),
      )
    assert.throws(
      () => new PostgresSignallingAuthorization(sql, { ...config, now: 1000 }),
    )
  } finally {
    await sql.end({ timeout: 0 })
  }
})
test('maintained login policy and guarded SQL expiry policy cannot drift silently', async () => {
  const runtime = await readFile(
    new URL('../../apps/farm/server/utils/auth/runtime.ts', import.meta.url),
    'utf8',
  )
  const migration = await readFile(
    new URL(
      '../../infra/db/migrations/0017_signalling_authorization.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const configured = runtime.match(
    /idleTimeoutMs:\s*([0-9]+(?:\s*\*\s*[0-9]+)*)\s*,/,
  )
  assert.ok(
    configured?.[1],
    'Review signalling expiry policy when changing maintained auth configuration',
  )
  const milliseconds = configured[1]
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1)
  assert.equal(
    milliseconds,
    SIGNALLING_IDLE_TIMEOUT_MS,
    'Auth idle policy changed: review SQL migration and passive reader before wiring',
  )
  const sqlPolicy = migration.match(
    /observed_now - session_row\.last_seen_at >= ([0-9]+)/,
  )
  assert.ok(sqlPolicy?.[1])
  assert.equal(Number(sqlPolicy[1]), milliseconds)
})
