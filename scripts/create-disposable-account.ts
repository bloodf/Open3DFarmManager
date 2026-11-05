// Synthetic bootstrap only. No URL argument and no production provisioning path.
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { hashPassword } from '../apps/farm/server/utils/auth/password.ts'
const port = Number(process.env.AUTH_SYNTHETIC_TEST_PORT)
if (
  process.env.AUTH_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL port required')
const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 1,
  connect_timeout: 3,
})
try {
  const passwordHash = await hashPassword(
    'synthetic-password-for-isolated-tests-only',
  )
  const id = randomUUID()
  await sql.begin(async (tx) => {
    await tx`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await tx`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${id}, 'fixture_user', ${passwordHash})`
  })
  console.log(
    JSON.stringify({
      result: 'created',
      username: 'fixture_user',
      accountId: id,
      synthetic: true,
    }),
  )
} finally {
  await sql.end({ timeout: 3 })
}
