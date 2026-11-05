import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresCredentials } from '../../apps/farm/server/storage/postgres-credentials.ts'

/** Caller owns the migrated disposable database and both connection pools. */
export async function testPostgresCredentials(
  adminSql: Sql,
  runtimeSql: Sql,
): Promise<string[]> {
  assert.equal(
    (await adminSql`SELECT current_database() AS name`)[0]?.name,
    'fixture',
  )
  assert.equal(
    (await runtimeSql`SELECT current_database() AS name`)[0]?.name,
    'fixture',
  )
  const suffix = randomUUID().replaceAll('-', '')
  const store = new PostgresCredentials(runtimeSql)
  const checks: string[] = []
  const originalHash = 'synthetic-not-a-real-password-hash-' + suffix
  const replacementHash = 'synthetic-replacement-password-hash-' + suffix
  const ownedLimitKeys: string[] = []
  async function denied(operation: PromiseLike<unknown>, code: string) {
    await assert.rejects(
      Promise.resolve(operation),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === code,
    )
  }
  async function seed(label: string) {
    const id = `cred_${label}_${suffix}`
    await adminSql`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await adminSql`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${id}, ${id}, ${originalHash})`
    const snapshot = await store.find(id)
    assert.ok(snapshot)
    assert.equal(snapshot.accountId, id)
    return snapshot
  }
  async function count(accountId: string) {
    return (
      await adminSql`SELECT count(*)::int AS n FROM farm.account_sessions WHERE account_id = ${accountId}`
    )[0]?.n
  }
  try {
    const current = await seed('current')
    const issued = await store.issue(current, 100, 1000)
    assert.equal(typeof issued, 'string')
    assert.equal(await count(current.accountId), 1)
    await adminSql.begin(async (tx) => {
      await tx`UPDATE farm.password_credentials SET password_hash = ${replacementHash}, credential_version = credential_version + 1 WHERE account_id = ${current.accountId}`
    })
    assert.equal(await store.issue(current, 100, 1000), null)
    const fresh = await store.find(current.accountId)
    assert.ok(fresh)
    assert.equal(
      await store.issue(
        { ...fresh, passwordHash: current.passwordHash },
        100,
        1000,
      ),
      null,
    )
    assert.equal(
      await store.issue(
        { ...fresh, credentialVersion: current.credentialVersion },
        100,
        1000,
      ),
      null,
    )
    assert.equal(await count(current.accountId), 1)
    assert.equal(typeof (await store.issue(fresh, 100, 1000)), 'string')
    checks.push('committed-password-change-rejects-old-version-and-old-hash')

    const disabled = await seed('disabled')
    await adminSql`UPDATE farm.session_accounts SET disabled = true WHERE id = ${disabled.accountId}`
    assert.equal(await store.issue(disabled, 100, 1000), null)
    assert.equal(await count(disabled.accountId), 0)
    const bumped = await seed('bumped')
    await adminSql`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${bumped.accountId}`
    assert.equal(await store.issue(bumped, 100, 1000), null)
    assert.equal(await count(bumped.accountId), 0)
    checks.push('disabled-and-changed-session-version-deny-issuance')

    const rollback = await seed('rollback')
    await denied(store.issue(rollback, -1, 1000), '23514')
    assert.equal(await count(rollback.accountId), 0)
    checks.push('failed-insert-rolls-back-without-session')

    const commit = await seed('commit')
    // Created without OR REPLACE: collisions fail instead of replacing another task's object.
    await adminSql.unsafe(`CREATE FUNCTION farm.credentials_fixture_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.account_id = TG_ARGV[0] THEN
          RAISE EXCEPTION 'Synthetic deferred session failure';
        END IF;
        RETURN NEW;
      END;
    $$`)
    try {
      const quoted = (
        await adminSql`SELECT quote_literal(${commit.accountId}::text) AS value`
      )[0]?.value
      assert.equal(typeof quoted, 'string')
      await adminSql.unsafe(`CREATE CONSTRAINT TRIGGER credentials_fixture_commit_guard
        AFTER INSERT ON farm.account_sessions DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION farm.credentials_fixture_commit_guard(${quoted})`)
      try {
        // The INSERT succeeds; the deferred trigger rejects the transaction at COMMIT.
        await denied(store.issue(commit, 100, 1000), 'P0001')
        assert.equal(await count(commit.accountId), 0)
      } finally {
        await adminSql`DROP TRIGGER credentials_fixture_commit_guard ON farm.account_sessions`
      }
    } finally {
      await adminSql`DROP FUNCTION farm.credentials_fixture_commit_guard()`
    }
    assert.equal(typeof (await store.issue(commit, 100, 1000)), 'string')
    checks.push('deferred-commit-failure-does-not-return-or-persist-session')

    await denied(
      runtimeSql`UPDATE farm.password_credentials SET password_hash = ${replacementHash} WHERE account_id = ${current.accountId}`,
      '42501',
    )
    await denied(
      runtimeSql`UPDATE farm.password_credentials SET account_id = ${bumped.accountId} WHERE account_id = ${current.accountId}`,
      '42501',
    )
    await denied(
      runtimeSql`UPDATE farm.password_credentials SET username = ${'renamed_' + suffix} WHERE account_id = ${current.accountId}`,
      '42501',
    )
    await denied(
      runtimeSql`UPDATE farm.password_credentials SET credential_version = credential_version WHERE account_id = ${current.accountId}`,
      'P0001',
    )
    await denied(runtimeSql`SET ROLE fixture`, '42501')
    await denied(
      runtimeSql`CREATE ROLE credentials_fixture_escalation SUPERUSER`,
      '42501',
    )
    checks.push(
      'restricted-role-cannot-replace-credentials-rebind-account-or-escalate',
    )

    for (const kind of ['a', 's'] as const) {
      const value = `credential-limiter-${kind}-${suffix}`
      const key = kind + ':' + createHash('sha256').update(value).digest('hex')
      ownedLimitKeys.push(key)
      const limit = kind === 'a' ? 15 : 60
      for (let index = 0; index < limit - 1; index++)
        assert.equal(await store.consumeLimit(kind, value), true)
      const otherCaller = new PostgresCredentials(runtimeSql)
      const results = await Promise.all([
        store.consumeLimit(kind, value),
        otherCaller.consumeLimit(kind, value),
      ])
      assert.deepEqual(results.sort(), [false, true])
      assert.equal(await otherCaller.consumeLimit(kind, value), false)
      await adminSql`UPDATE farm.auth_rate_limits SET window_start = clock_timestamp() - interval '15 minutes' WHERE key = ${key}`
      assert.equal(await store.consumeLimit(kind, value), true)
      assert.equal(
        (
          await adminSql`SELECT attempts FROM farm.auth_rate_limits WHERE key = ${key}`
        )[0]?.attempts,
        1,
      )
    }
    checks.push(
      'account-and-source-limit-boundaries-shared-callers-and-window-reset',
    )
    checks.push(
      'synthetic-account-session-tombstones-retained-for-disposable-db-teardown',
    )
    return checks
  } finally {
    for (const key of ownedLimitKeys)
      await adminSql`DELETE FROM farm.auth_rate_limits WHERE key = ${key}`
  }
}
