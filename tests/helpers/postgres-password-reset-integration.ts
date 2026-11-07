import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresPasswordReset } from '../../apps/farm/server/storage/postgres-password-reset.ts'

/** Disposable migrated database only. Caller owns pools, roles and database teardown. */
export async function testPostgresPasswordReset(admin: Sql, runtime: Sql) {
  const store = new PostgresPasswordReset(runtime)
  const id = randomUUID()
  const username = 'reset_' + id.replaceAll('-', '')
  const other = 'reset_' + randomUUID().replaceAll('-', '')
  const digest = 'a'.repeat(64)
  const replacement = 'synthetic-reset-password-hash-000000000000'
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${id}), (${other})`
  await admin`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${id}, ${username}, ${'synthetic-original-password-hash-000000000'}), (${other}, ${other}, ${'synthetic-original-password-hash-000000000'})`
  await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${id}, ${id}, 0, 1, 1, 9007199254740991)`
  assert.equal(await store.issue(username, digest), true)
  assert.equal(await store.consume(other, digest, replacement), false)
  assert.equal(
    await store.consume(username, 'b'.repeat(64), replacement),
    false,
  )
  await admin`UPDATE farm.password_reset_tokens SET issued_at = clock_timestamp() - interval '16 minutes', expires_at = clock_timestamp() - interval '1 minute' WHERE account_id = ${id}`
  assert.equal(await store.consume(username, digest, replacement), false)
  assert.equal(await store.issue(username, digest), true)
  const concurrent = await Promise.all([
    store.consume(username, digest, replacement),
    store.consume(username, digest, replacement),
  ])
  assert.deepEqual(concurrent.sort(), [false, true])
  assert.equal(await store.consume(username, digest, replacement), false)
  const credentials =
    await admin`SELECT password_hash, credential_version::text AS version FROM farm.password_credentials WHERE account_id = ${id}`
  assert.equal(credentials[0]?.password_hash, replacement)
  assert.equal(credentials[0]?.version, '1')
  const sessions =
    await admin`SELECT session_version::text AS version FROM farm.session_accounts WHERE id = ${id}`
  assert.equal(sessions[0]?.version, '1')
  assert.equal(await store.issue(username, digest), true)
  await admin`UPDATE farm.password_credentials SET credential_version = credential_version + 1 WHERE account_id = ${id}`
  assert.equal(await store.consume(username, digest, replacement), false)
  assert.equal(await store.issue(username, digest), true)
  await admin`UPDATE farm.session_accounts SET disabled = true WHERE id = ${id}`
  assert.equal(await store.consume(username, digest, replacement), false)
  return [
    'reset account binding',
    'reset digest mismatch',
    'reset expiry',
    'reset concurrent single use',
    'reset credential replacement and session revocation',
    'reset stale credential version',
    'reset disabled account',
  ]
}
