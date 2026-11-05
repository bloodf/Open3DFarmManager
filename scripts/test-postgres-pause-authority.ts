// Caller owns a disposable loopback PostgreSQL database with the maintained full migration journal.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, realpath, lstat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import {
  testPostgresPauseAuthority,
  verifyPauseAuthorityReplayRestart,
} from '../tests/helpers/postgres-pause-authority-integration.ts'
import {
  testPauseAuthorityCatalog,
  capturePauseAuthorityRestart,
  verifyPauseAuthorityRestart,
} from '../tests/helpers/postgres-pause-authority-catalog.ts'
import { testPauseConnectorRevocations } from '../tests/helpers/postgres-pause-authority-revocations.ts'
import {
  requirePauseTimeoutLogPath,
  testPauseAuthorityTransactionTimeout,
  type PauseTimeoutReceipt,
} from '../tests/helpers/postgres-pause-authority-timeout.ts'
const portText = process.env.PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT,
  port = Number(portText)
const phase = process.argv[2] ?? 'run'
if (
  process.env.PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535 ||
  !['run', 'prepare-restart', 'verify-restart'].includes(phase) ||
  process.argv.length > 3
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL fixture and supported phase required',
  )
const base = process.env.PAUSE_AUTHORITY_SYNTHETIC_RESTART_BASE
if (phase !== 'run' && (!base || !isAbsolute(base)))
  throw new Error('Absolute private restart handoff path required')
if (base) {
  const checkout = await realpath(new URL('..', import.meta.url))
  const parent = await realpath(dirname(base))
  const worktrees = execFileSync(
    'git',
    ['worktree', 'list', '--porcelain', '-z'],
    {
      cwd: checkout,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1048576,
    },
  )
    .split('\0')
    .filter((entry) => entry.startsWith('worktree '))
  if (worktrees.length === 0)
    throw new Error('Cannot verify private handoff location')
  for (const entry of worktrees) {
    const root = await realpath(entry.slice('worktree '.length))
    const outside = relative(root, parent)
    if (!outside.startsWith('../') && outside !== '..')
      throw new Error(
        'Restart handoff must be outside every repository worktree',
      )
  }
}
if (
  phase === 'prepare-restart' &&
  process.env.PAUSE_AUTHORITY_SYNTHETIC_FUTURE_WATERMARK === 'yes'
)
  throw new Error('Use a separate fixture for injected future watermark')
// This is a path inside the caller-owned disposable PostgreSQL server, not the host.
const serverLogPath =
  phase === 'verify-restart'
    ? undefined
    : requirePauseTimeoutLogPath(
        process.env.PAUSE_AUTHORITY_SYNTHETIC_SERVER_LOG,
      )
const admin = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  ssl: false,
  max: 6,
  connect_timeout: 3,
})
try {
  const identity = (
    await admin`SELECT current_database() AS database,current_user AS username`
  )[0]
  assert.deepEqual(
    { ...identity },
    { database: 'fixture', username: 'fixture' },
  )
  const catalog = await loadMigrationCatalog(),
    history =
      await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(catalog.length, 18)
  assert.equal(catalog.at(-1)?.id, '0018_pause_authority')
  assert.equal(validateMigrationHistory(catalog, [...history]), 18)
  let checks: string[]
  let timeout: PauseTimeoutReceipt | undefined
  if (phase === 'verify-restart') {
    if (!base) throw new Error('Missing restart base')
    for (const path of [base + '.private.json', base + '.catalog.json']) {
      const details = await lstat(path)
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        (details.mode & 0o077) !== 0 ||
        details.size > 1048576
      )
        throw new Error('Invalid private restart handoff')
    }
    const receipt = JSON.parse(await readFile(base + '.catalog.json', 'utf8'))
    checks = [
      ...(await verifyPauseAuthorityRestart(admin, receipt)),
      ...(await verifyPauseAuthorityReplayRestart(
        admin,
        port,
        base + '.private.json',
      )),
    ]
  } else {
    const catalogChecks = await testPauseAuthorityCatalog(admin, port)
    const revocationChecks = await testPauseConnectorRevocations(admin, port)
    assert.ok(serverLogPath)
    timeout = await testPauseAuthorityTransactionTimeout(
      admin,
      port,
      serverLogPath,
    )
    checks = [
      ...catalogChecks,
      ...revocationChecks,
      'server-attributed-ten-second-transaction-timeout-before-main-pool',
      ...(await testPostgresPauseAuthority(
        admin,
        port,
        phase === 'prepare-restart' && base
          ? base + '.private.json'
          : undefined,
      )),
    ]
    if (phase === 'prepare-restart') {
      if (!base) throw new Error('Missing restart base')
      await writeFile(
        base + '.catalog.json',
        JSON.stringify(await capturePauseAuthorityRestart(admin)),
        { flag: 'wx', mode: 0o600 },
      )
    }
  }
  console.log(
    JSON.stringify({ result: 'passed', phase, checks, journal: 18, timeout }),
  )
} finally {
  await admin.end({ timeout: 3 })
}
