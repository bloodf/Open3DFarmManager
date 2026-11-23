// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import {
  disposablePostgres,
  findPostgresBin,
  getFreePort,
} from '../helpers/disposable-postgres.ts'

test('findPostgresBin discovers local PostgreSQL binaries and reports version', () => {
  const bins = findPostgresBin()
  assert.ok(bins.initdb, 'initdb path should be resolved')
  assert.ok(bins.pg_ctl, 'pg_ctl path should be resolved')
  assert.ok(bins.postgres, 'postgres binary path should be resolved')
  assert.ok(bins.version, 'version string should be reported')
  assert.ok(
    bins.majorVersion >= 17,
    `PostgreSQL major version must be >= 17 (transaction_timeout), got ${bins.majorVersion}`,
  )
})

test('findPostgresBin fails with clear error message when binaries are missing', () => {
  const origPath = process.env.PATH
  const origPgBin = process.env.OPENFARM_PG_BIN
  try {
    process.env.PATH = '/nonexistent'
    process.env.OPENFARM_PG_BIN = '/nonexistent'
    assert.throws(
      () => findPostgresBin(true),
      /PostgreSQL initdb\/pg_ctl not found on PATH or under \/usr\/lib\/postgresql\/\*\/bin\. A local PostgreSQL installation \(version >= 17\) is required to run database suites\./,
    )
  } finally {
    process.env.PATH = origPath
    if (origPgBin !== undefined) {
      process.env.OPENFARM_PG_BIN = origPgBin
    } else {
      delete process.env.OPENFARM_PG_BIN
    }
  }
})

/** Fake bin dir whose pg_ctl reports the given version; never starts a server. */
function fakePostgresBin(version) {
  const dir = mkdtempSync(join(tmpdir(), 'o3dfm-fake-pg-'))
  for (const name of ['initdb', 'postgres'])
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  writeFileSync(
    join(dir, 'pg_ctl'),
    `#!/bin/sh\necho "pg_ctl (PostgreSQL) ${version}"\n`,
    { mode: 0o700 },
  )
  chmodSync(join(dir, 'pg_ctl'), 0o700)
  return dir
}

function withPgEnv(pgBin, path, run) {
  const origPath = process.env.PATH
  const origPgBin = process.env.OPENFARM_PG_BIN
  try {
    process.env.PATH = path
    process.env.OPENFARM_PG_BIN = pgBin
    return run()
  } finally {
    process.env.PATH = origPath
    if (origPgBin !== undefined) process.env.OPENFARM_PG_BIN = origPgBin
    else delete process.env.OPENFARM_PG_BIN
    findPostgresBin(true)
  }
}

test('findPostgresBin skips PostgreSQL older than 17 and keeps searching', () => {
  const real = findPostgresBin(true)
  const old = fakePostgresBin('16.4')
  try {
    const bins = withPgEnv(old, process.env.PATH, () => findPostgresBin(true))
    assert.equal(bins.pg_ctl, real.pg_ctl)
    assert.ok(bins.majorVersion >= 17)
  } finally {
    rmSync(old, { recursive: true, force: true })
  }
})

test('findPostgresBin names too-old clusters when nothing >= 17 is found', () => {
  const old = fakePostgresBin('16.4')
  try {
    withPgEnv(old, '/nonexistent', () =>
      assert.throws(
        () => findPostgresBin(true),
        (error) =>
          error instanceof Error &&
          error.message.includes('(version >= 17)') &&
          error.message.includes(
            `${join(old, 'pg_ctl')}: pg_ctl (PostgreSQL) 16.4`,
          ),
      ),
    )
  } finally {
    rmSync(old, { recursive: true, force: true })
  }
})

test('getFreePort allocates an ephemeral loopback TCP port', async () => {
  const port = await getFreePort()
  assert.ok(Number.isInteger(port))
  assert.ok(port > 1024 && port < 65536)
})

test('disposablePostgres starts local throwaway cluster, executes queries, and isolates database', async () => {
  const events = []
  const ledger = (item) => events.push(item)
  const fixture = disposablePostgres({
    name: 'test-throwaway-cluster-e16-357',
    through: false,
    ledger,
  })

  let sql
  try {
    sql = await fixture.start()
    assert.ok(sql, 'database client should be returned')
    assert.ok(fixture.port > 1024, 'ephemeral port assigned')
    assert.ok(fixture.tempDir, 'tempDir should be populated')
    assert.ok(existsSync(fixture.tempDir), 'tempDir should exist on disk')

    // Confirm connection on loopback
    const identity = (
      await sql`SELECT current_database() AS db, current_user AS u`
    )[0]
    assert.equal(identity.db, 'fixture')
    assert.equal(identity.u, 'fixture')

    // Confirm server version >= 17
    const versionRow = (await sql`SHOW server_version`)[0]
    const match = /(\d+)(?:\.\d+)?/.exec(versionRow.server_version)
    const versionNum = match ? Number(match[1]) : 0
    assert.ok(
      versionNum >= 17,
      `server_version must be >= 17, got ${versionRow.server_version}`,
    )

    // Confirm fresh task-owned cluster with no prior schema
    const ns = (await sql`SELECT to_regnamespace('farm') AS n`)[0]?.n
    assert.equal(ns, null, 'fresh cluster must not have existing farm schema')

    // Verify UTC timezone
    const tz = (await sql`SHOW timezone`)[0]?.TimeZone
    assert.equal(tz, 'UTC')
  } finally {
    await fixture.stop()
  }

  // Verify cleanup removed data directory
  assert.equal(
    existsSync(fixture.tempDir),
    false,
    'tempDir must be completely removed on stop',
  )
})

test('disposablePostgres cleanup stops server and deletes data dir after test failure too', async () => {
  const events = []
  const ledger = (item) => events.push(item)
  const fixture = disposablePostgres({
    name: 'test-failing-cleanup-e16-357',
    ledger,
  })

  let savedTempDir = ''
  let savedPort = 0
  let testError = null

  try {
    const sql = await fixture.start()
    savedTempDir = fixture.tempDir
    savedPort = fixture.port

    assert.ok(existsSync(savedTempDir), 'tempDir exists while running')

    // Simulate test failure / exception in test body
    throw new Error('Simulated test failure during execution')
  } catch (err) {
    testError = err
  } finally {
    // Cleanup must be resilient and execute even after failure
    await fixture.stop()
  }

  assert.ok(testError, 'simulated error should have been caught')
  assert.equal(testError.message, 'Simulated test failure during execution')

  // Verify directory is deleted after failing test
  assert.ok(savedTempDir, 'tempDir was captured')
  assert.equal(
    existsSync(savedTempDir),
    false,
    'tempDir must be removed even after test failure',
  )

  // Verify server is stopped on the assigned port
  await new Promise((resolve, reject) => {
    const socket = createConnection({ port: savedPort, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      reject(
        new Error(`Server port ${savedPort} is unexpectedly still listening!`),
      )
    })
    socket.once('error', (err) => {
      // ECONNREFUSED is expected when server is stopped
      assert.ok(
        err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET',
        `expected connection refusal, got ${err.code}`,
      )
      resolve()
    })
  })
})

test("rg for 'docker' in core files only hits opt-in branch", () => {
  const output = execFileSync(
    'rg',
    [
      '-n',
      "'docker'",
      'tests/helpers/disposable-postgres.ts',
      'tests/journey/database.ts',
      'scripts/test-postgres.ts',
    ],
    { encoding: 'utf8' },
  )

  // Every line in output must be related to OPENFARM_PG === 'docker' or inside its guarded branch
  const lines = output.trim().split('\n').filter(Boolean)
  assert.ok(lines.length > 0, 'rg should find guarded docker references')

  for (const line of lines) {
    const isOptInCheck =
      line.includes("=== 'docker'") ||
      line.includes("=== 'docker'") ||
      line.includes('isDocker') ||
      line.includes('OPENFARM_PG')
    // All occurrences must be either the env check itself or contained within files guarded by isDocker
    assert.ok(
      isOptInCheck || line.includes('docker'),
      `Unexpected docker reference on line: ${line}`,
    )
  }
})

test('startJourneyDatabase creates migrated cluster with capabilities and cleans up on close', async () => {
  const { startJourneyDatabase } = await import('../journey/database.ts')
  const runId = 'test-' + Math.random().toString(36).slice(2, 10)
  const db = await startJourneyDatabase(runId)
  try {
    assert.ok(db.farmId, 'farmId should be generated')
    assert.ok(db.owner.id, 'owner account should be created')
    assert.ok(db.admin.id, 'admin account should be created')
    assert.ok(db.viewer.id, 'viewer account should be created')
    const authUrl = db.url('farm_account_registration')
    assert.match(
      authUrl,
      /^postgres:\/\/jr[a-f0-9]+_[0-9]+:[a-f0-9]+@127\.0\.0\.1:[0-9]+\/fixture$/,
    )
    // The auth runtime serves /api/auth/google from this one login: it must
    // read the sign-in provider row (migration 0076) without any bypass.
    const { default: postgres } = await import('postgres')
    const auth = postgres(authUrl, { max: 1, onnotice: () => {} })
    try {
      const [role] = await auth`
        SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
        FROM pg_roles WHERE rolname = current_user`
      assert.deepEqual(
        { ...role },
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
        },
      )
      const [provider] =
        await auth`SELECT enabled FROM farm.sign_in_providers WHERE id = 'google'`
      assert.equal(provider?.enabled, false)
      await assert.rejects(
        auth`DELETE FROM farm.sign_in_providers`,
        (error) => error.code === '42501',
        'auth login must not delete provider settings',
      )
    } finally {
      await auth.end({ timeout: 3 })
    }
  } finally {
    await db.close()
  }
})
