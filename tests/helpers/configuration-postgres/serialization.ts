import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ReservedSql, Sql } from 'postgres'
import type { ConfigurationOperationRecord } from '../../../apps/farm/server/services/configuration-authority-contract.ts'
import { PostgresConfigurationStore } from '../../../apps/farm/server/storage/postgres-configuration.ts'

type Scope = {
  sessionRecordId: string
  farmId: string
  agentId: string
  keyId: string
}
type Input = {
  admin: Sql
  sql: Sql
  role: string
  config: ConstructorParameters<typeof PostgresConfigurationStore>[1]
  scope: Scope
  account: string
  farm: string
  operation: (id: string) => ConfigurationOperationRecord
  record: (event: object) => Promise<unknown>
}

const code = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null

/** Counts real transaction attempts without changing the production pool. */
function counted(sql: Sql) {
  const counter = { begins: 0 }
  const proxy = new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== 'begin') return Reflect.get(target, property, receiver)
      return (...args: unknown[]) => {
        counter.begins++
        return (target.begin as (...a: unknown[]) => unknown)(...args)
      }
    },
  })
  return { sql: proxy, counter }
}

/**
 * Overlapping transactions are ordered by observed PostgreSQL lock waits, not by
 * elapsed time: the writer commits only after the store backend is proven
 * blocked behind the writer's row lock. The store's first attempt then fails
 * with SQLSTATE 40001 on its FOR UPDATE/FOR SHARE read under serializable.
 */
export async function qualifySerializationRecovery(input: Input) {
  const { admin, role, config, scope, account, farm, operation, record } = input
  const now = async () =>
    Number(
      (
        await admin`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now`
      )[0]?.now,
    )
  const operations = async (id: string) =>
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.configuration_operations WHERE operation_id=${id}::uuid`
      )[0]?.n,
    )
  const durable = async () =>
    JSON.stringify({
      challenges: [
        ...(await admin`SELECT * FROM farm.configuration_challenges ORDER BY challenge_id`),
      ],
      receipts: [
        ...(await admin`SELECT * FROM farm.configuration_receipts ORDER BY operation_id`),
      ],
      assignments: [
        ...(await admin`SELECT * FROM farm.printer_assignments ORDER BY id`),
      ],
    })
  const backend = async (writer: ReservedSql) =>
    Number((await writer`SELECT pg_backend_pid() AS pid`)[0]?.pid)
  const blocked = async (writerPid: number) => {
    const until = Date.now() + 4000
    while (Date.now() < until) {
      const rows =
        await admin`SELECT pid FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock' AND ${writerPid}::int = ANY(pg_blocking_pids(pid))`
      if (rows.length === 1) return Number(rows[0]?.pid)
      await delay(20)
    }
    throw new Error('Store transaction never waited on the writer lock')
  }
  const session = async (expiresIn = 1800000) => {
    const id = 'serialization_' + randomUUID()
    const at = await now()
    await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${id},${account},0,${at},${at},${at + expiresIn})`
    return { id, at, expiresAt: at + expiresIn }
  }
  /** Writer holds an uncommitted row update; the store blocks behind it; then the writer commits. */
  async function overlapped<T>(
    write: (writer: ReservedSql) => Promise<unknown>,
    run: () => Promise<T>,
    beforeCommit: () => Promise<void> = async () => {},
  ) {
    const writer = await admin.reserve()
    try {
      await writer`BEGIN ISOLATION LEVEL READ COMMITTED`
      await write(writer)
      const pending = run()
      pending.catch(() => {})
      const waiting = await blocked(await backend(writer))
      await beforeCommit()
      await writer`COMMIT`
      return { pending, waiting }
    } catch (error) {
      await writer`ROLLBACK`.catch(() => {})
      throw error
    } finally {
      writer.release()
    }
  }
  const cases: object[] = []
  const baseline = await durable()

  // 1. Exact production shape: a session touch commits while the store waits in
  // farm.observe_signalling_session_expiry (FOR UPDATE on farm.account_sessions).
  {
    const { sql, counter } = counted(input.sql)
    const store = new PostgresConfigurationStore(sql, config)
    const id = randomUUID()
    let calls = 0
    const { pending } = await overlapped(
      (w) =>
        w`UPDATE farm.account_sessions SET last_seen_at=GREATEST(last_seen_at,floor(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE id=${scope.sessionRecordId}`,
      () =>
        store.transaction(scope, async (tx) => {
          calls++
          if (!tx.authority) return null
          return {
            role: tx.authority.role,
            created: await tx.createOperation(operation(id)),
          }
        }),
    )
    const outcome = await pending.catch((error: unknown) => ({
      rejected: code(error),
    }))
    await record({
      stage: 'serialization_session_touch',
      outcome,
      begins: counter.begins,
      calls,
    })
    assert.deepEqual(outcome, { role: 'owner', created: true })
    assert.equal(counter.begins, 2)
    assert.equal(calls, 1)
    assert.equal(await operations(id), 1)
    cases.push({ case: 'session_touch_recovered', begins: counter.begins })
  }

  // 2. Callback replay: attempt one performs a write, then hits 40001 inside the
  // callback; the retry must start from a fresh snapshot with no partial write.
  const pinned = randomUUID()
  await new PostgresConfigurationStore(input.sql, config).transaction(
    scope,
    async (tx) => assert.ok(await tx.createOperation(operation(pinned))),
  )
  const conflictInside = async (attempts: number) => {
    const { sql, counter } = counted(input.sql)
    const store = new PostgresConfigurationStore(sql, config)
    const id = randomUUID()
    let calls = 0
    const result = await store
      .transaction(scope, async (tx) => {
        calls++
        assert.ok(tx.authority)
        const created = await tx.createOperation(operation(id))
        if (calls <= attempts)
          await admin`UPDATE farm.configuration_operations SET record=record WHERE operation_id=${pinned}::uuid`
        const locked = await tx.operation(pinned)
        return { created, locked: locked?.operation_id ?? null }
      })
      .catch((error: unknown) => ({ rejected: code(error) }))
    return { result, begins: counter.begins, calls, rows: await operations(id) }
  }
  {
    const replay = await conflictInside(1)
    await record({ stage: 'serialization_callback_replay', ...replay })
    assert.deepEqual(replay, {
      result: { created: true, locked: pinned },
      begins: 2,
      calls: 2,
      rows: 1,
    })
    cases.push({ case: 'callback_replayed_fresh', begins: replay.begins })
  }

  // 3. Finite exhaustion: every attempt conflicts; the 40001 surfaces and nothing persists.
  {
    const exhausted = await conflictInside(Number.MAX_SAFE_INTEGER)
    await record({ stage: 'serialization_exhaustion', ...exhausted })
    assert.deepEqual(exhausted, {
      result: { rejected: '40001' },
      begins: 3,
      calls: 3,
      rows: 0,
    })
    cases.push({ case: 'finite_exhaustion', begins: exhausted.begins })
  }

  // 4. Non-serialization database error (lock_timeout 55P03): never retried.
  {
    const { sql, counter } = counted(input.sql)
    const store = new PostgresConfigurationStore(sql, config)
    const id = randomUUID()
    const writer = await admin.reserve()
    let outcome: unknown
    try {
      await writer`BEGIN`
      await writer`SELECT operation_id FROM farm.configuration_operations WHERE operation_id=${pinned}::uuid FOR UPDATE`
      outcome = await store
        .transaction(scope, async (tx) => {
          await tx.createOperation(operation(id))
          return tx.operation(pinned)
        })
        .catch((error: unknown) => ({ rejected: code(error) }))
    } finally {
      await writer`ROLLBACK`.catch(() => {})
      writer.release()
    }
    await record({
      stage: 'serialization_other_error',
      outcome,
      begins: counter.begins,
    })
    assert.deepEqual(outcome, { rejected: '55P03' })
    assert.equal(counter.begins, 1)
    assert.equal(await operations(id), 0)
    cases.push({ case: 'lock_timeout_not_retried', begins: counter.begins })
  }

  // 5. Unknown outcome (backend terminated mid-transaction): never retried.
  {
    const { sql, counter } = counted(input.sql)
    const store = new PostgresConfigurationStore(sql, config)
    const id = randomUUID()
    const outcome = await store
      .transaction(scope, async (tx) => {
        await tx.createOperation(operation(id))
        const idle =
          await admin`SELECT pid FROM pg_stat_activity WHERE usename=${role} AND state='idle in transaction'`
        assert.equal(idle.length, 1)
        await admin`SELECT pg_terminate_backend(${Number(idle[0]?.pid)}::int, 5000)`
        return tx.operation(pinned)
      })
      .catch((error: unknown) => ({ rejected: code(error) }))
    await record({
      stage: 'serialization_unknown_outcome',
      outcome,
      begins: counter.begins,
    })
    assert.ok(
      typeof outcome === 'object' &&
        outcome !== null &&
        'rejected' in outcome &&
        outcome.rejected !== '40001',
    )
    assert.equal(counter.begins, 1)
    assert.equal(await operations(id), 0)
    cases.push({ case: 'unknown_outcome_not_retried', begins: counter.begins })
  }

  // 6-8. Revocation, expiry and membership downgrade committed between attempts:
  // the retry re-reads authority from a fresh snapshot and denies.
  const denial = async (
    stage: string,
    target: Scope,
    write: (w: ReservedSql) => Promise<unknown>,
    beforeCommit?: () => Promise<void>,
  ) => {
    const { sql, counter } = counted(input.sql)
    const store = new PostgresConfigurationStore(sql, config)
    const id = randomUUID()
    let calls = 0
    const { pending } = await overlapped(
      write,
      () =>
        store.transaction(target, async (tx) => {
          calls++
          if (!tx.authority) return 'denied'
          await tx.createOperation(operation(id))
          return 'granted'
        }),
      beforeCommit,
    )
    const outcome = await pending.catch((error: unknown) => ({
      rejected: code(error),
    }))
    await record({ stage, outcome, begins: counter.begins, calls })
    assert.equal(outcome, 'denied')
    assert.equal(counter.begins, 2)
    assert.equal(calls, 1)
    assert.equal(await operations(id), 0)
    cases.push({ case: stage, begins: counter.begins })
  }
  {
    const revoked = await session()
    const target = { ...scope, sessionRecordId: revoked.id }
    assert.ok(
      await new PostgresConfigurationStore(input.sql, config).read(target),
    )
    await denial(
      'session_revoked_between_attempts',
      target,
      (w) =>
        w`UPDATE farm.account_sessions SET revoked_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE id=${revoked.id}`,
    )
  }
  {
    const expiring = await session(2500)
    const target = { ...scope, sessionRecordId: expiring.id }
    assert.ok(
      await new PostgresConfigurationStore(input.sql, config).read(target),
    )
    await denial(
      'session_expired_between_attempts',
      target,
      (w) =>
        w`UPDATE farm.account_sessions SET last_seen_at=last_seen_at+1 WHERE id=${expiring.id}`,
      async () => {
        // Commit only once the database clock has passed the absolute expiry.
        while ((await now()) < expiring.expiresAt) await delay(20)
      },
    )
    const persisted =
      await admin`SELECT revoked_at::float8 AS revoked_at FROM farm.account_sessions WHERE id=${expiring.id}`
    assert.ok(Number(persisted[0]?.revoked_at) >= expiring.expiresAt)
  }
  await denial(
    'membership_downgraded_between_attempts',
    scope,
    (w) =>
      w`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${account}`,
  )
  await admin`UPDATE farm.memberships SET role='owner' WHERE farm_id=${farm}::uuid AND account_id=${account}`
  assert.equal(
    (await new PostgresConfigurationStore(input.sql, config).read(scope))
      ?.authority.role,
    'owner',
  )
  assert.equal(await durable(), baseline)
  await record({
    qualification: 'configuration_serialization_recovery',
    status: 'pass',
    cases,
  })
}
