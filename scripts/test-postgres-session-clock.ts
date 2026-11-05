import assert from 'node:assert/strict'
import postgres from 'postgres'
import { testPostgresSessionClock } from '../tests/helpers/postgres-session-clock.ts'

const port = Number(process.env.SESSION_CLOCK_DISPOSABLE_PORT)
const systemId = process.env.SESSION_CLOCK_DISPOSABLE_SYSTEM_ID
if (
  process.env.SESSION_CLOCK_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !systemId ||
  !/^[0-9]{1,20}$/.test(systemId)
)
  throw Error('Explicit disposable loopback identity required')
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  connect_timeout: 3,
  connection: { statement_timeout: 2000, lock_timeout: 1000 },
}
const admin = postgres({ ...options, max: 2 })
const runtime = postgres({
  ...options,
  max: 1,
  connection: { ...options.connection, role: 'farm_session_runtime' },
})
try {
  assert.equal(
    String(
      (await admin`SELECT system_identifier FROM pg_control_system()`)[0]
        ?.system_identifier,
    ),
    systemId,
  )
  assert.equal(
    (await runtime`SELECT current_user AS actor`)[0]?.actor,
    'farm_session_runtime',
  )
  console.log(
    JSON.stringify({ checks: await testPostgresSessionClock(admin, runtime) }),
  )
} finally {
  const closed = await Promise.allSettled([
    runtime.end({ timeout: 1 }),
    admin.end({ timeout: 1 }),
  ])
  if (closed.some((result) => result.status === 'rejected'))
    throw Error('Session clock fixture cleanup failed')
}
