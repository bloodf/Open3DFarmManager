// Disposable local PostgreSQL 17 cluster for the Docker-free (OPENFARM_SIM=mock)
// outage run. Loopback TCP only, trust auth, data inside the caller's work
// directory, removed with it. Stops exactly the postmaster it started.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const CANDIDATE_DIRS = [
  process.env.OUTAGE_TEST_PG_BIN,
  process.env.OPENFARM_PG_BIN,
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@17/bin',
  '/usr/lib/postgresql/17/bin',
]

function binary(name: string) {
  for (const dir of CANDIDATE_DIRS)
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  return name // PATH fallback; the version check below rejects a wrong major.
}

export async function startLocalPostgres(input: {
  workDir: string
  port: number
  ledger: (value: object) => void
}) {
  const [initdb, pgCtl, createdb, postgresBin] = [
    'initdb',
    'pg_ctl',
    'createdb',
    'postgres',
  ].map(binary) as [string, string, string, string]
  const version = (await exec(postgresBin, ['--version'])).stdout
  if (!/ 17\./.test(version))
    throw new Error(
      `PostgreSQL 17 required for the local cluster, got ${version.trim()}`,
    )
  const data = join(input.workDir, 'pgdata')
  const log = join(input.workDir, 'postgres.log')
  await exec(
    initdb,
    ['-D', data, '-U', 'fixture', '-A', 'trust', '-E', 'UTF8', '--no-sync'],
    { timeout: 60000 },
  )
  input.ledger({
    resource: 'local-postgres-data',
    path: data,
    port: input.port,
  })
  const options = [
    ...['-c', `port=${input.port}`, '-c', 'listen_addresses=127.0.0.1'],
    ...['-c', 'unix_socket_directories=', '-c', 'fsync=off'],
    ...['-c', 'synchronous_commit=off', '-c', 'max_connections=60'],
  ].join(' ')
  await exec(
    pgCtl,
    ['-D', data, '-l', log, '-w', '-t', '60', '-o', options, 'start'],
    {
      timeout: 90000,
    },
  )
  input.ledger({ resource: 'local-postgres-process', data })
  const stop = async () => {
    await exec(
      pgCtl,
      ['-D', data, '-m', 'immediate', '-w', '-t', '30', 'stop'],
      {
        timeout: 60000,
      },
    )
    input.ledger({ removed: 'local-postgres-process', data })
  }
  try {
    await exec(
      createdb,
      ['-h', '127.0.0.1', '-p', String(input.port), '-U', 'fixture', 'fixture'],
      { timeout: 30000 },
    )
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
  const stopSync = () => {
    execFileSync(
      pgCtl,
      ['-D', data, '-m', 'immediate', '-w', '-t', '30', 'stop'],
      { timeout: 35000 },
    )
    input.ledger({ removed: 'local-postgres-process', data })
  }
  return { stop, stopSync, logPath: log }
}
