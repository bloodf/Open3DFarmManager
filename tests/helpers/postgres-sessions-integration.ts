import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'

const policy = { idleTimeoutMs: 100 }
export async function testPostgresSessions(
  admin: Sql,
  runtime: Sql,
): Promise<string[]> {
  const store = new PostgresSessionRepository(
    runtime,
    (requestedAt) => requestedAt,
  )
  const checks: string[] = []
  async function seed(id: string) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${id}, ${id}, 0, 100, 100, 1000)`
  }
  async function waitForLock(fragment: string) {
    const start = performance.now()
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${'%' + fragment + '%'}`
      if ((rows[0]?.n ?? 0) > 0) return
      assert.ok(performance.now() - start < 750, 'Expected database lock wait')
      await sleep(5)
    }
  }
  await seed('boundaries')
  assert.deepEqual(await store.authorizeAndTouch('boundaries', 199, policy), {
    ok: true,
    accountId: 'boundaries',
    touchAt: 199,
  })
  assert.deepEqual(await store.authorizeAndTouch('boundaries', 299, policy), {
    ok: false,
    reason: 'expired',
  })
  assert.deepEqual(await store.authorizeAndTouch('boundaries', 250, policy), {
    ok: false,
    reason: 'revoked',
  })
  assert.deepEqual(await store.authorizeAndTouch('boundaries', 198, policy), {
    ok: false,
    reason: 'invalid-state',
  })
  assert.deepEqual(
    await store.authorizeAndTouch('boundaries', 1000, { idleTimeoutMs: 10000 }),
    { ok: false, reason: 'revoked' },
  )
  await seed('absolute')
  assert.deepEqual(
    await store.authorizeAndTouch('absolute', 1000, { idleTimeoutMs: 10000 }),
    { ok: false, reason: 'expired' },
  )
  assert.deepEqual(await store.authorizeAndTouch('absent', 100, policy), {
    ok: false,
    reason: 'missing',
  })
  assert.deepEqual(await store.authorizeAndTouch("' OR TRUE --", 100, policy), {
    ok: false,
    reason: 'invalid-state',
  })
  await seed('isolated')
  await store.revokeAccountSessions('boundaries')
  assert.equal(
    (await store.authorizeAndTouch('isolated', 150, policy)).ok,
    true,
  )
  await seed('disabled')
  await admin`UPDATE farm.session_accounts SET disabled = true WHERE id = 'disabled'`
  assert.deepEqual(await store.authorizeAndTouch('disabled', 100, policy), {
    ok: false,
    reason: 'revoked',
  })
  assert.deepEqual(
    await store.authorizeAndTouch('isolated', 100, { idleTimeoutMs: 0 }),
    { ok: false, reason: 'invalid-state' },
  )
  await store.revokeAccountSessions('absent')
  checks.push('expiry-boundaries-clock-regression-and-account-isolation')

  for (const kind of ['account', 'session']) {
    const id = 'revoke_first_' + kind
    await seed(id)
    let release!: () => void
    let ready!: () => void
    const locked = new Promise<void>((resolve) => {
      ready = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = admin.begin(async (tx) => {
      await tx`SELECT id FROM farm.session_accounts WHERE id = ${id} FOR UPDATE`
      if (kind === 'account')
        await tx`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${id}`
      else
        await tx`UPDATE farm.account_sessions SET revoked_at = 101 WHERE id = ${id}`
      ready()
      await gate
    })
    await locked
    const authorization = store.authorizeAndTouch(id, 102, policy)
    try {
      await waitForLock('FROM farm.session_accounts')
    } finally {
      release()
      await writer
    }
    assert.deepEqual(await authorization, { ok: false, reason: 'revoked' })

    const reverse = 'authorize_first_' + kind
    await seed(reverse)
    // A trigger pauses the real adapter after it holds account and session locks.
    await admin
      .unsafe(
        `CREATE FUNCTION farm.pause_session_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(490040); RETURN NEW; END; $$; CREATE TRIGGER pause_touch BEFORE UPDATE OF last_seen_at ON farm.account_sessions FOR EACH ROW EXECUTE FUNCTION farm.pause_session_touch();`,
      )
      .simple()
    const blocker = await admin.reserve()
    await blocker`SELECT pg_advisory_lock(490040)`
    let result: ReturnType<typeof store.authorizeAndTouch> | undefined
    let revocation: Promise<void> | undefined
    try {
      result = store.authorizeAndTouch(reverse, 101, policy)
      await waitForLock('UPDATE farm.account_sessions SET last_seen_at')
      revocation =
        kind === 'account'
          ? store.revokeAccountSessions(reverse)
          : store.revokeSession(reverse, 102)
      await waitForLock(
        kind === 'account'
          ? 'UPDATE farm.session_accounts SET session_version'
          : 'SELECT id FROM farm.session_accounts',
      )
    } finally {
      await blocker`SELECT pg_advisory_unlock(490040)`
      blocker.release()
    }
    assert.equal((await result)?.ok, true)
    await revocation
    await admin
      .unsafe(
        'DROP TRIGGER pause_touch ON farm.account_sessions; DROP FUNCTION farm.pause_session_touch();',
      )
      .simple()
    assert.deepEqual(await store.authorizeAndTouch(reverse, 103, policy), {
      ok: false,
      reason: 'revoked',
    })
  }
  checks.push('both-lock-orders-for-session-and-account-revocation')

  await seed('rollback')
  await assert.rejects(
    admin.begin(async (tx) => {
      await tx`UPDATE farm.session_accounts SET session_version = 1 WHERE id = 'rollback'`
      throw new Error('rollback fixture')
    }),
    /rollback fixture/,
  )
  assert.equal(
    (await store.authorizeAndTouch('rollback', 101, policy)).ok,
    true,
  )
  // Deferred failure occurs during COMMIT, after adapter callback returned success.
  await admin
    .unsafe(
      `CREATE FUNCTION farm.fail_session_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER UPDATE ON farm.account_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_session_commit();`,
    )
    .simple()
  assert.deepEqual(await store.authorizeAndTouch('rollback', 102, policy), {
    ok: false,
    reason: 'storage-unavailable',
  })
  assert.equal(
    (
      await admin`SELECT last_seen_at::int AS n FROM farm.account_sessions WHERE id = 'rollback'`
    )[0]?.n,
    101,
  )
  await admin
    .unsafe(
      'DROP TRIGGER fail_commit ON farm.account_sessions; DROP FUNCTION farm.fail_session_commit();',
    )
    .simple()
  const lock = await admin.reserve()
  await lock`BEGIN`
  await lock`SELECT id FROM farm.session_accounts WHERE id = 'rollback' FOR UPDATE`
  try {
    const start = performance.now()
    assert.deepEqual(await store.authorizeAndTouch('rollback', 102, policy), {
      ok: false,
      reason: 'storage-unavailable',
    })
    assert.ok(performance.now() - start < 4000)
  } finally {
    await lock`ROLLBACK`
    lock.release()
  }
  await store.revokeSession('rollback', 102)
  await store.revokeSession('rollback', 103)
  await store.revokeSession('absent', 103)
  checks.push('rollback-commit-error-lock-timeout-and-idempotent-revocation')

  await admin`INSERT INTO farm.session_accounts (id, session_version) VALUES ('exhausted', 9007199254740991)`
  await assert.rejects(store.revokeAccountSessions('exhausted'))
  assert.equal(
    (
      await admin`SELECT session_version::text AS n FROM farm.session_accounts WHERE id = 'exhausted'`
    )[0]?.n,
    '9007199254740991',
  )
  checks.push(...(await testSessionPrivileges(runtime)))
  return [...checks, 'version-exhaustion-fails-without-wraparound']
}

export async function testSessionPrivileges(runtime: Sql): Promise<string[]> {
  for (const query of [
    "INSERT INTO farm.session_accounts (id) VALUES ('unauthorized')",
    'UPDATE farm.session_accounts SET disabled = false',
    'UPDATE farm.session_accounts SET session_version = session_version - 1 WHERE session_version > 0',
    "UPDATE farm.account_sessions SET account_id = 'isolated'",
    'UPDATE farm.account_sessions SET revoked_at = NULL WHERE revoked_at IS NOT NULL',
    'UPDATE farm.account_sessions SET last_seen_at = 0',
    'DELETE FROM farm.account_sessions',
    'DELETE FROM farm.session_accounts',
    'TRUNCATE farm.account_sessions',
    'DROP TABLE farm.account_sessions',
    'CREATE TABLE farm.unauthorized (id int)',
    'ALTER ROLE session_fixture SUPERUSER',
    'SET ROLE fixture',
  ])
    await assert.rejects(runtime.unsafe(query))
  return ['runtime-cannot-issue-rebind-resurrect-delete-ddl-or-escalate']
}
