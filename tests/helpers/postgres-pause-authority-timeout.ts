import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { z } from 'zod'

const maxLogBytes = 5 * 1024 * 1024
const maxAppendBytes = 64 * 1024
const epoch = z.number().finite().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const observation = z
  .object({
    pid: z.number().int().positive(),
    dbStart: epoch,
    dbEnd: epoch,
    elapsedMs: z.number().finite().min(10000).max(20000),
    backendGone: z.literal(true),
    beforeBytes: z.number().int().min(0).max(maxLogBytes),
    afterBytes: z.number().int().min(0).max(maxLogBytes),
    beforeDigest: digest,
    retainedDigest: digest,
    appended: z.string(),
  })
  .strict()

export function requirePauseTimeoutLogPath(value: unknown): string {
  const path = z.string().min(2).max(4096).parse(value)
  assert.ok(
    posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      !/[\0\r\n]/.test(path),
    'Explicit canonical task-server-log path required',
  )
  return path
}

/** The caller supplies actual fixture-admin reads, never a client disconnect as evidence. */
export function validatePauseTimeoutServerReceipt(input: unknown): {
  pid: number
  sqlstate: '25P04'
  dbStart: number
  dbEnd: number
  fatalEpoch: number
} {
  const value = observation.parse(input)
  assert.ok(value.dbEnd > value.dbStart, 'Invalid database interval')
  assert.ok(
    value.afterBytes > value.beforeBytes,
    'Missing or truncated server log',
  )
  assert.equal(
    value.retainedDigest,
    value.beforeDigest,
    'Server log prefix changed or was truncated',
  )
  const count = value.afterBytes - value.beforeBytes
  assert.ok(
    count <= maxAppendBytes,
    'Server log append exceeds bounded capture',
  )
  assert.equal(
    Buffer.byteLength(value.appended),
    count,
    'Truncated server log capture',
  )
  assert.ok(value.appended.endsWith('\n'), 'Incomplete server log line')
  const lines = value.appended
    .split('\n')
    .filter(
      (line) => line.includes(`[${value.pid}]`) && line.includes('FATAL:'),
    )
  assert.equal(lines.length, 1, 'Missing or ambiguous backend FATAL')
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) UTC \[(\d+)\] FATAL:\s+25P04: terminating connection due to transaction timeout$/.exec(
      lines[0] ?? '',
    )
  assert.ok(match, 'Expected exact server transaction-timeout SQLSTATE 25P04')
  assert.equal(Number(match[3]), value.pid)
  const fatalEpoch = Date.parse(`${match[1]}T${match[2]}Z`) / 1000
  assert.ok(
    Number.isFinite(fatalEpoch) &&
      fatalEpoch >= value.dbStart &&
      fatalEpoch <= value.dbEnd,
    'FATAL timestamp outside database interval',
  )
  assert.ok(
    fatalEpoch - value.dbStart >= 9.5 && fatalEpoch - value.dbStart < 20,
    'FATAL does not match the fixed ten-second transaction window',
  )
  return {
    pid: value.pid,
    sqlstate: '25P04',
    dbStart: value.dbStart,
    dbEnd: value.dbEnd,
    fatalEpoch,
  }
}

type ClientSettlement =
  | { kind: 'pending' }
  | { kind: 'resolved' }
  | { kind: 'rejected'; code: string | null }
export interface PauseTimeoutReceipt {
  server: ReturnType<typeof validatePauseTimeoutServerReceipt> & {
    backendStart: string
  }
  client: { beforePoolEnd: ClientSettlement; afterPoolEnd: ClientSettlement }
}

async function logSize(admin: Sql, path: string): Promise<number> {
  const row = (
    await admin`SELECT size::float8 AS size,isdir FROM pg_stat_file(${path},true)`
  )[0]
  return z
    .object({
      size: z.number().int().min(0).max(maxLogBytes),
      isdir: z.literal(false),
    })
    .parse(row).size
}

/** Disposable fixture only. Settles and closes its max-one pool before the main issuer pool exists. */
export async function testPauseAuthorityTransactionTimeout(
  admin: Sql,
  port: number,
  serverLogPath: string,
): Promise<PauseTimeoutReceipt> {
  const path = requirePauseTimeoutLogPath(serverLogPath)
  const role = 'pause_timeout_fixture_' + randomUUID().replaceAll('-', '')
  let created = false,
    sql: Sql | undefined,
    primary: unknown,
    failed = false
  let running: Promise<void> | undefined
  let client: ClientSettlement = { kind: 'pending' }
  let beforePoolEnd: ClientSettlement = { kind: 'pending' }
  let server: PauseTimeoutReceipt['server'] | undefined
  const cleanupErrors: unknown[] = []
  try {
    const beforeBytes = await logSize(admin, path)
    const beforeDigest = digest.parse(
      (
        await admin`SELECT encode(sha256(pg_read_binary_file(${path},0,${beforeBytes},true)),'hex') AS digest`
      )[0]?.digest,
    )
    await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_pause_authority`
    created = true
    await admin`ALTER ROLE ${admin(role)} SET log_error_verbosity='verbose'`
    sql = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: role,
      max: 1,
      connect_timeout: 3,
      connection: {
        application_name: role,
        options: '-c role=farm_pause_authority',
        statement_timeout: 2000,
        lock_timeout: 1000,
        transaction_timeout: 10000,
      },
    })
    const settings = (
      await sql`SELECT pg_backend_pid() AS pid,current_user AS role,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('transaction_timeout') AS transaction,current_setting('log_error_verbosity') AS verbosity`
    )[0]
    const parsed = z
      .object({
        pid: z.number().int().positive(),
        role: z.literal('farm_pause_authority'),
        statement: z.literal('2s'),
        lock: z.literal('1s'),
        transaction: z.literal('10s'),
        verbosity: z.literal('verbose'),
      })
      .parse(settings)
    const backends =
      await admin`SELECT backend_start::text AS started FROM pg_stat_activity WHERE pid=${parsed.pid} AND usename=${role} AND application_name=${role} AND datname='fixture'`
    assert.equal(backends.length, 1, 'Expected exact owned runtime backend')
    const backendStart = z.string().min(1).parse(backends[0]?.started)
    const started = performance.now()
    let dbStart: number | undefined
    running = sql
      .begin(async (tx) => {
        const inside = (
          await tx`SELECT pg_backend_pid() AS pid,current_user AS role,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('transaction_timeout') AS transaction,extract(epoch FROM clock_timestamp())::float8 AS epoch`
        )[0]
        assert.equal(inside?.pid, parsed.pid)
        assert.equal(inside?.role, 'farm_pause_authority')
        assert.equal(inside?.statement, '2s')
        assert.equal(inside?.lock, '1s')
        assert.equal(inside?.transaction, '10s')
        dbStart = epoch.parse(inside?.epoch)
        for (let i = 0; i < 20; i++) await tx`SELECT pg_sleep(0.75)`
      })
      .then(
        () => {
          client = { kind: 'resolved' }
        },
        (error: unknown) => {
          client = {
            kind: 'rejected',
            code:
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              typeof error.code === 'string'
                ? error.code
                : null,
          }
        },
      )
    await new Promise((resolve) => setTimeout(resolve, 11000))
    const remaining = (
      await admin`SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=${parsed.pid} AND backend_start::text=${backendStart}`
    )[0]?.count
    assert.equal(
      remaining,
      0,
      'Timed-out backend still exists before pool cleanup',
    )
    const healthy = (
      await admin`SELECT 1::int AS healthy,extract(epoch FROM clock_timestamp())::float8 AS epoch`
    )[0]
    assert.equal(healthy?.healthy, 1)
    const afterBytes = await logSize(admin, path)
    assert.ok(
      afterBytes > beforeBytes && afterBytes - beforeBytes <= maxAppendBytes,
      'Missing, truncated or oversized server log append',
    )
    const captured = (
      await admin`SELECT encode(sha256(pg_read_binary_file(${path},0,${beforeBytes},true)),'hex') AS digest,pg_read_file(${path},${beforeBytes},${afterBytes - beforeBytes},true) AS appended`
    )[0]
    server = {
      ...validatePauseTimeoutServerReceipt({
        pid: parsed.pid,
        dbStart,
        dbEnd: healthy?.epoch,
        elapsedMs: performance.now() - started,
        backendGone: true,
        beforeBytes,
        afterBytes,
        beforeDigest,
        retainedDigest: captured?.digest,
        appended: captured?.appended,
      }),
      backendStart,
    }
  } catch (error) {
    primary = error
    failed = true
  } finally {
    beforePoolEnd = client
    if (sql)
      try {
        await sql.end({ timeout: 1 })
      } catch (error) {
        cleanupErrors.push(error)
      }
    // Do not leave an owned backend behind merely because pool.end failed.
    if (created) {
      try {
        const owned =
          await admin`SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE usename=${role} AND application_name=${role} AND datname='fixture'`
        assert.ok(owned.length <= 1, 'Unexpected extra timeout-probe backend')
        for (const row of owned) {
          const pid = z.number().int().positive().parse(row.pid),
            start = z.string().min(1).parse(row.started)
          await admin`SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE pid=${pid} AND backend_start::text=${start} AND usename=${role} AND application_name=${role} AND datname='fixture'`
        }
        const left = (
          await admin`SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=${role} AND application_name=${role} AND datname='fixture'`
        )[0]?.count
        assert.equal(left, 0, 'Owned timeout backend survived cleanup')
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (running)
      await Promise.race([
        running,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
    if (created)
      try {
        await admin`DROP ROLE ${admin(role)}`
      } catch (error) {
        cleanupErrors.push(error)
      }
    if (created)
      try {
        const left = (
          await admin`SELECT count(*)::int AS count FROM pg_roles WHERE rolname=${role}`
        )[0]?.count
        assert.equal(left, 0, 'Owned timeout role survived cleanup')
      } catch (error) {
        cleanupErrors.push(error)
      }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [primary, ...cleanupErrors] : cleanupErrors,
      'Timeout fixture cleanup failed',
    )
  if (failed) throw primary
  assert.ok(server)
  assert.equal(
    client.kind,
    'rejected',
    'Client settlement remains inconclusive after pool cleanup',
  )
  return { server, client: { beforePoolEnd, afterPoolEnd: client } }
}
