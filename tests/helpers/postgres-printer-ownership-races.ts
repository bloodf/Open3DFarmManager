import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'

/** Real lock races in the caller-owned disposable fixture; no printer connection. */
export async function testPrinterOwnershipRaces(
  admin: Sql,
  runtime: Sql,
): Promise<string[]> {
  let now = 2000000
  const service = new PostgresPrinterOwnership(runtime, () => now)
  const farmId = randomUUID()
  await admin`INSERT INTO farm.farms (id) VALUES (${farmId}::uuid)`
  async function actor() {
    const id = randomUUID()
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${id},${id},0,${now},${now},${now + 100000})`
    await admin`INSERT INTO farm.memberships (farm_id,account_id,role) VALUES (${farmId}::uuid,${id},'owner')`
    return id
  }
  async function agent() {
    const id = randomUUID()
    await admin`INSERT INTO farm.connector_enrollments (agent_id,farm_id,public_key_spki,fingerprint) VALUES (${id}::uuid,${farmId}::uuid,${'A'.repeat(59)},${'SHA256:' + 'A'.repeat(43)})`
    await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${id}::uuid`
    return id
  }
  function request(
    sessionRecordId: string,
    agentId: string,
    printerKey: string,
  ) {
    return {
      sessionRecordId,
      agentId,
      printerKey,
      farmId,
      policy: { idleTimeoutMs: 50000 },
    }
  }
  async function count(key: string) {
    return Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid AND printer_key=${key} AND revoked_at IS NULL`
      )[0]?.n,
    )
  }
  async function waitForBlocked(fragment: string) {
    const end = performance.now() + 750
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='printer-ownership-fixture' AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (Number(rows[0]?.n) > 0) return
      assert.ok(performance.now() < end, 'Expected runtime lock wait')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  async function blocked<T>(
    hold: (tx: TransactionSql) => Promise<void>,
    start: () => Promise<T>,
    fragment: string,
    beforeRelease?: () => void,
  ): Promise<T> {
    let ready!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      ready = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transaction = admin.begin(async (tx) => {
      await hold(tx)
      ready()
      await gate
    })
    let operation: Promise<T> | undefined
    try {
      await Promise.race([
        held,
        transaction.then(() => {
          throw new Error('Lock released early')
        }),
      ])
      operation = start()
      await waitForBlocked(fragment)
      beforeRelease?.()
    } finally {
      release()
      await transaction
    }
    if (!operation) throw new Error('Operation did not start')
    return await operation
  }
  const target = await agent()
  for (const kind of [
    'account',
    'session',
    'membership-revoke',
    'membership-downgrade',
    'expiry',
  ] as const) {
    const user = await actor()
    const key = `wait-${kind}`
    const outcome = await blocked(
      async (tx) => {
        if (kind === 'account')
          await tx`UPDATE farm.session_accounts SET disabled=true WHERE id=${user}`
        else if (kind === 'session')
          await tx`UPDATE farm.account_sessions SET revoked_at=${now} WHERE id=${user}`
        else if (kind === 'membership-revoke')
          await tx`UPDATE farm.memberships SET revoked_at=${now} WHERE farm_id=${farmId}::uuid AND account_id=${user}`
        else if (kind === 'membership-downgrade')
          await tx`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farmId}::uuid AND account_id=${user}`
        else
          await tx`SELECT agent_id FROM farm.connector_enrollments WHERE agent_id=${target}::uuid FOR UPDATE`
      },
      () => service.register(request(user, target, key)),
      kind === 'account'
        ? 'session_accounts'
        : kind === 'session'
          ? 'account_sessions'
          : kind.startsWith('membership')
            ? 'memberships'
            : 'connector_enrollments',
      kind === 'expiry'
        ? () => {
            now += 100001
          }
        : undefined,
    )
    assert.deepEqual(outcome, { ok: false, reason: 'denied' })
    assert.equal(await count(key), 0)
    if (kind === 'expiry')
      assert.notEqual(
        (
          await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${user}`
        )[0]?.revoked_at,
        null,
      )
  }
  const user = await actor(),
    revokedFirst = await agent(),
    registrationFirst = await agent()
  const denied = await blocked(
    async (tx) => {
      await tx`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${revokedFirst}::uuid`
    },
    () => service.register(request(user, revokedFirst, 'revoked-first')),
    'connector_enrollments',
  )
  assert.deepEqual(denied, { ok: false, reason: 'denied' })
  assert.equal(await count('revoked-first'), 0)
  // A competing uncommitted key holds the unique index while registration holds
  // its enrollment lock. Roll it back only after enrollment revocation waits.
  const competitor = await agent()
  let prepared!: () => void
  let unblock!: () => void
  const ready = new Promise<void>((resolve) => {
    prepared = resolve
  })
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const rollback = new Error('fixture rollback')
  const blocker = admin
    .begin(async (tx) => {
      await tx`INSERT INTO farm.printer_assignments (id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${randomUUID()}::uuid,${farmId}::uuid,${competitor}::uuid,'registration-first',${now},${user})`
      prepared()
      await gate
      throw rollback
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error
    })
  let registration: ReturnType<typeof service.register> | undefined
  let enrollmentRevocation: Promise<unknown> | undefined
  try {
    await Promise.race([
      ready,
      blocker.then(() => {
        throw new Error('Blocker exited early')
      }),
    ])
    registration = service.register(
      request(user, registrationFirst, 'registration-first'),
    )
    await waitForBlocked('INSERT INTO farm.printer_assignments')
    enrollmentRevocation = Promise.resolve(
      admin`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${registrationFirst}::uuid`,
    )
    const end = performance.now() + 750
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE farm.connector_enrollments SET status=%'`
      if (Number(rows[0]?.n) > 0) break
      assert.ok(performance.now() < end, 'Expected enrollment revocation wait')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  } finally {
    unblock()
    await blocker
  }
  assert.equal((await registration).ok, true)
  await enrollmentRevocation
  assert.equal(await count('registration-first'), 1)
  assert.equal(
    (
      await admin`SELECT status FROM farm.connector_enrollments WHERE agent_id=${registrationFirst}::uuid`
    )[0]?.status,
    'revoked',
  )
  assert.deepEqual(
    await service.register(request(user, registrationFirst, 'after-revoke')),
    { ok: false, reason: 'denied' },
  )
  assert.equal(await count('after-revoke'), 0)
  const readable = await agent(),
    readRequest = request(user, readable, 'read-lock')
  assert.equal((await service.register(readRequest)).ok, true)
  const revoked = await blocked(
    async (tx) => {
      await tx`SELECT id FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid AND printer_key='read-lock' AND revoked_at IS NULL FOR SHARE`
    },
    () => service.revoke(readRequest),
    'printer_assignments',
  )
  assert.equal(revoked.ok, true)
  assert.equal(await count('read-lock'), 0)
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid AND printer_key='read-lock' AND revoked_at IS NOT NULL`
      )[0]?.n,
    ),
    1,
  )
  return [
    'account, session and membership changes while waiting',
    'lock-wait session expiry',
    'both enrollment revocation orders',
    'assignment shared-read versus revocation',
  ]
}
