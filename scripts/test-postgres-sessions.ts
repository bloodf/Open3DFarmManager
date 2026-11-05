// Opt-in destructive fixture. Run only against a fresh, disposable loopback database.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { PostgresSessionRepository } from '../apps/farm/server/storage/postgres-session.ts'
import {
  testPostgresSessions,
  testSessionPrivileges,
} from '../tests/helpers/postgres-sessions-integration.ts'

const port = Number(process.env.SESSIONS_SYNTHETIC_TEST_PORT)
if (
  process.env.SESSIONS_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable PostgreSQL port required')
const options = {
  hostname: '127.0.0.1',
  port,
  database: 'fixture',
  max: 6,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture' })
const runtime = postgres({ ...options, username: 'session_fixture' })
const store = new PostgresSessionRepository(runtime)
const up = await readFile(
  new URL(
    '../infra/db/migrations/0004_account_sessions.up.sql',
    import.meta.url,
  ),
  'utf8',
)
const down = await readFile(
  new URL(
    '../infra/db/migrations/0004_account_sessions.down.sql',
    import.meta.url,
  ),
  'utf8',
)
const checks: string[] = []
try {
  if (process.argv.includes('--after-restart')) {
    assert.equal(
      (
        await admin`SELECT last_seen_at::int AS n FROM farm.account_sessions WHERE id = 'isolated'`
      )[0]?.n,
      150,
    )
    assert.deepEqual(
      await store.authorizeAndTouch('absolute', 999, { idleTimeoutMs: 10000 }),
      { ok: false, reason: 'revoked' },
    )
    assert.deepEqual(
      await store.authorizeAndTouch('rollback', 103, { idleTimeoutMs: 100 }),
      { ok: false, reason: 'revoked' },
    )
    assert.deepEqual(
      await store.authorizeAndTouch('boundaries', 200, { idleTimeoutMs: 100 }),
      { ok: false, reason: 'revoked' },
    )
    assert.equal(
      (await store.authorizeAndTouch('isolated', 249, { idleTimeoutMs: 100 }))
        .ok,
      true,
    )
    checks.push(
      'touch-session-and-account-revocation-survive-restart',
      ...(await testSessionPrivileges(runtime)),
    )
    await runtime.end()
    await admin.begin(async (tx) => {
      await tx.unsafe(down).simple()
    })
    await admin.begin(async (tx) => {
      await tx.unsafe(up).simple()
    })
    assert.equal(
      (await admin`SELECT count(*)::int AS n FROM farm.account_sessions`)[0]?.n,
      0,
    )
    await admin.begin(async (tx) => {
      await tx.unsafe(down).simple()
    })
    await admin`DROP ROLE session_fixture`
    await admin`DROP SCHEMA farm`
    checks.push('up-down-up-and-fixture-schema-cleanup')
  } else {
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'farm'`
      )[0]?.n,
      0,
      'Fresh dedicated database required',
    )
    await admin.begin(async (tx) => {
      await tx`CREATE SCHEMA farm`
      await tx.unsafe(up).simple()
      await tx`CREATE ROLE session_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_session_runtime`
    })
    checks.push(...(await testPostgresSessions(admin, runtime)))
  }
} finally {
  await runtime.end()
  await admin.end()
}
assert.deepEqual(
  await store.authorizeAndTouch('isolated', 102, { idleTimeoutMs: 100 }),
  { ok: false, reason: 'storage-unavailable' },
)
console.log(
  JSON.stringify({
    result: 'passed',
    checks: [...checks, 'closed-pool-fails-closed'],
  }),
)
