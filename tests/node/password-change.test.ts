import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'
import { PostgresCredentials } from '../../apps/farm/server/storage/postgres-credentials.ts'

function database() {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?')
    statements.push({ sql: statement, values })
    return Promise.resolve(
      statement.includes('RETURNING account_id')
        ? [{ account_id: 'account-1' }]
        : [],
    )
  }
  const sql = Object.assign(query, {
    begin: async <T>(operation: (tx: typeof query) => Promise<T>) =>
      operation(query),
  })
  return { sql: sql as never, statements }
}

test('password replacement is conditional on the credential snapshot', async () => {
  const db = database()
  const credentials = new PostgresCredentials(db.sql)
  const updated = await credentials.replacePassword(
    {
      accountId: 'account-1',
      passwordHash: 'old-hash',
      credentialVersion: '4',
      sessionVersion: '2',
    },
    'new-hash',
  )
  assert.equal(updated, true)
  const update = db.statements.at(-1)!
  assert.match(update.sql, /credential_version::text = \?/)
  assert.match(update.sql, /password_hash = \?/)
  assert.deepEqual(update.values, ['new-hash', 'account-1', '4', 'old-hash'])
})

test('password change revokes other sessions while keeping the current session', async () => {
  const db = database()
  const sessions = new PostgresSessionRepository(db.sql)
  await sessions.revokeOtherSessions('account-1', 'session-current', 1234)
  const revoke = db.statements.at(-1)!
  assert.match(
    revoke.sql,
    /account_id = \? AND id <> \? AND revoked_at IS NULL/,
  )
  assert.deepEqual(revoke.values, [1234, 'account-1', 'session-current', 1234])
})

test('sign out everywhere increments the account session version', async () => {
  const db = database()
  const sessions = new PostgresSessionRepository(db.sql)
  await sessions.revokeAccountSessions('account-1')
  assert.match(
    db.statements.at(-1)!.sql,
    /session_version = session_version \+ 1/,
  )
  assert.deepEqual(db.statements.at(-1)!.values, ['account-1'])
})
