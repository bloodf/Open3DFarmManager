import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'

/** Requires a disposable database and a dedicated runtime pool with max: 1. */
export async function testPostgresSessionClock(admin: Sql, runtime: Sql) {
  const [backend] = await runtime<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`
  assert.ok(backend)
  const { pid } = backend
  const checks: string[] = []
  for (const kind of [
    'concurrent-touch',
    'expiry-during-wait',
    'clock-regression',
  ] as const) {
    const id = 'clock_' + randomUUID().replaceAll('-', '')
    const requestedAt = Date.now()
    const observedAt =
      kind === 'expiry-during-wait'
        ? requestedAt + 1000
        : kind === 'clock-regression'
          ? requestedAt - 1
          : undefined
    await admin`INSERT INTO farm.session_accounts(id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${id},${id},0,${requestedAt},${requestedAt},${requestedAt + 1000})`
    let release = () => {},
      ready = () => {}
    const locked = new Promise<void>((resolve) => {
      ready = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = admin.begin(async (tx) => {
      await tx`SELECT id FROM farm.session_accounts WHERE id=${id} FOR UPDATE`
      await tx`UPDATE farm.account_sessions SET last_seen_at=${requestedAt + 1} WHERE id=${id}`
      ready()
      await gate
    })
    let reader:
      | ReturnType<PostgresSessionRepository['authorizeAndTouch']>
      | undefined
    try {
      await Promise.race([
        locked,
        writer.then(() => {
          throw Error('Writer ended before lock')
        }),
      ])
      const store =
        observedAt === undefined
          ? new PostgresSessionRepository(runtime)
          : new PostgresSessionRepository(runtime, () => observedAt)
      reader = store.authorizeAndTouch(id, requestedAt, { idleTimeoutMs: 1000 })
      const start = performance.now()
      while (
        !(
          await admin`SELECT pid FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock'`
        ).length
      ) {
        assert.ok(
          performance.now() - start < 750,
          'Reader must contend on actual account lock',
        )
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      release()
      await writer
      const result = await reader
      if (kind === 'concurrent-touch') {
        assert.equal(result.ok, true)
        if (result.ok) assert.ok(result.touchAt > requestedAt)
      } else
        assert.deepEqual(result, {
          ok: false,
          reason: kind === 'clock-regression' ? 'invalid-state' : 'expired',
        })
      const [row] =
        await admin`SELECT last_seen_at::float8 AS touched, revoked_at::float8 AS revoked FROM farm.account_sessions WHERE id=${id}`
      assert.ok(row)
      if (kind === 'expiry-during-wait') assert.equal(row.revoked, observedAt)
      else assert.equal(row.revoked, null)
      if (kind !== 'concurrent-touch')
        assert.equal(row.touched, requestedAt + 1)
      checks.push(kind)
    } finally {
      release()
      await Promise.allSettled([writer, reader])
      await admin`UPDATE farm.account_sessions SET revoked_at=COALESCE(revoked_at,GREATEST(last_seen_at,${Date.now()})) WHERE id=${id}`
    }
  }
  return checks
}
