// Disposable local PostgreSQL 17 cluster for the Docker-free (OPENFARM_SIM=mock)
// outage run. Loopback TCP requires SCRAM for privileged roles and trusts ordinary
// test logins. The data lives in the caller's work directory. Stops exactly the
// postmaster it started.
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fixturePostgresHba } from './fixture-postgres-hba.ts'

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

async function postgresEnv(postgresBin: string) {
  const env = { ...process.env }
  // pg_config reports paths relative to the selected installation, including
  // unpacked distributions whose libraries are outside the system search path.
  const pgConfig = join(dirname(postgresBin), 'pg_config')
  if (
    process.platform === 'linux' &&
    isAbsolute(pgConfig) &&
    existsSync(pgConfig)
  ) {
    const libdir = (
      await exec(pgConfig, ['--libdir'], { timeout: 5000 })
    ).stdout.trim()
    if (isAbsolute(libdir) && existsSync(libdir))
      env.LD_LIBRARY_PATH = [libdir, env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(delimiter)
  }
  return env
}

const isRequiredVersion = (version: string) => / 17\./.test(version)

/** Whether the binaries selected by this helper are available for a v17 cluster. */
export async function hasLocalPostgres(): Promise<boolean> {
  try {
    const postgresBin = binary('postgres')
    const env = await postgresEnv(postgresBin)
    const version = (
      await exec(postgresBin, ['--version'], { env, timeout: 5000 })
    ).stdout
    if (!isRequiredVersion(version)) return false
    for (const name of ['initdb', 'pg_ctl', 'createdb'])
      await exec(binary(name), ['--version'], { env, timeout: 5000 })
    return true
  } catch {
    return false
  }
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
  const env = await postgresEnv(postgresBin)
  const version = (await exec(postgresBin, ['--version'], { env })).stdout
  if (!isRequiredVersion(version))
    throw new Error(
      `PostgreSQL 17 required for the local cluster, got ${version.trim()}`,
    )
  const data = join(input.workDir, 'pgdata')
  const log = join(input.workDir, 'postgres.log')
  const password = randomBytes(32).toString('hex')
  const passwordFile = join(input.workDir, 'postgres-password')
  await writeFile(passwordFile, password, { mode: 0o600 })
  await exec(
    initdb,
    [
      '-D',
      data,
      '-U',
      'fixture',
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      `--pwfile=${passwordFile}`,
      '-E',
      'UTF8',
      '--no-sync',
    ],
    { env, timeout: 60000 },
  )
  await writeFile(join(data, 'pg_hba.conf'), fixturePostgresHba())
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
      env,
      timeout: 90000,
    },
  )
  input.ledger({ resource: 'local-postgres-process', data })
  const stop = async () => {
    await exec(
      pgCtl,
      ['-D', data, '-m', 'immediate', '-w', '-t', '30', 'stop'],
      {
        env,
        timeout: 60000,
      },
    )
    input.ledger({ removed: 'local-postgres-process', data })
  }
  try {
    await exec(
      createdb,
      ['-h', '127.0.0.1', '-p', String(input.port), '-U', 'fixture', 'fixture'],
      { env: { ...env, PGPASSWORD: password }, timeout: 30000 },
    )
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
  const stopSync = () => {
    execFileSync(
      pgCtl,
      ['-D', data, '-m', 'immediate', '-w', '-t', '30', 'stop'],
      { env, timeout: 35000 },
    )
    input.ledger({ removed: 'local-postgres-process', data })
  }
  return { stop, stopSync, logPath: log, password }
}
