import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, appendFile, writeFile, statfs } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { acceptanceOptions } from '../tests/helpers/configuration-postgres/options.ts'
import {
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { qualifyConfiguration } from '../tests/helpers/configuration-postgres/scenarios.ts'

const options = acceptanceOptions(
  process.env,
  fileURLToPath(new URL('..', import.meta.url)),
)
const exec = promisify(execFile)
const id = randomUUID()
const name = `openfarm-configuration-${id}`
const evidence = join(options.evidence, id)
await mkdir(evidence, { recursive: true, mode: 0o700 })
const record = async (value: object) =>
  appendFile(join(evidence, 'events.jsonl'), JSON.stringify(value) + '\n', {
    mode: 0o600,
  })
const docker = async (...args: string[]) =>
  (
    await exec('docker', ['--context', options.context, ...args], {
      timeout: 120000,
      maxBuffer: 2 ** 20,
    })
  ).stdout.trim()
const pools: ReturnType<typeof postgres>[] = []
const connect = (username: string) => {
  const sql = postgres({
    host: '127.0.0.1',
    port: options.port,
    database: 'fixture',
    username,
    max: 2,
    connect_timeout: 3,
    connection: {
      statement_timeout: 10000,
      lock_timeout: 5000,
      transaction_timeout: 20000,
    },
  })
  pools.push(sql)
  return sql
}
let container = ''
let failed = false
try {
  const disk = await statfs(evidence)
  assert.ok(disk.bavail * disk.bsize > 10 * 1024 ** 3)
  await record({
    head: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    options,
    name,
  })
  await record({ image: await docker('image', 'inspect', options.image) })
  const sharedNetwork = options.context.replace(/^colima-/, '') + '-net'
  const subnet = await docker(
    'network',
    'inspect',
    '--format',
    '{{(index .IPAM.Config 0).Subnet}}',
    sharedNetwork,
  )
  assert.match(subnet, /^[0-9.]+\/[0-9]+$/)
  await exec(
    'limactl',
    [
      'shell',
      options.context,
      'sudo',
      'iptables',
      '-C',
      'DOCKER-USER',
      '-s',
      subnet,
      '-m',
      'conntrack',
      '--ctstate',
      'NEW',
      '-j',
      'DROP',
    ],
    {
      timeout: 15000,
      env: { ...process.env, LIMA_HOME: join(homedir(), '.colima/_lima') },
    },
  )
  await record({ sharedNetwork, subnet, egressRuleVerified: true })
  container = await docker(
    'create',
    '--name',
    name,
    '--label',
    `openfarm.configuration=${id}`,
    '--network',
    sharedNetwork,
    '--restart',
    'no',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--tmpfs',
    '/var/lib/postgresql/data:rw',
    '-p',
    `127.0.0.1:${options.port}:5432`,
    '-e',
    'POSTGRES_USER=fixture',
    '-e',
    'POSTGRES_DB=fixture',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    options.image,
  )
  await record({ container })
  await docker('start', container)
  await docker(
    'exec',
    container,
    'sh',
    '-c',
    'n=0; until pg_isready -U fixture -d fixture; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
  )
  const readyUntil = Date.now() + 30000
  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({
          host: '127.0.0.1',
          port: options.port,
        })
        socket.setTimeout(1000)
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        socket.once('error', reject)
        socket.once('timeout', () => {
          socket.destroy()
          reject(new Error('Loopback port timeout'))
        })
      })
      break
    } catch (error) {
      if (Date.now() >= readyUntil) throw error
      await delay(250)
    }
  }
  const admin = connect('fixture')
  assert.equal((await admin`SELECT to_regnamespace('farm') AS n`)[0]?.n, null)
  assert.match((await admin`SHOW server_version`)[0]?.server_version, /^17\./)
  const catalog = await loadMigrationCatalog()
  assert.ok(catalog.some((m) => m.id === '0026_configuration'))
  await runMigrations(admin, catalog, { kind: 'up' })
  assert.equal(
    validateMigrationHistory(catalog, [
      ...(await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`),
    ]),
    catalog.length,
  )
  await qualifyConfiguration(admin, connect, record)
} catch (error) {
  failed = true
  await record({
    failure:
      error instanceof Error
        ? { ...error, message: error.message, stack: error.stack }
        : String(error),
  })
  throw error
} finally {
  const cleanupErrors: string[] = []
  for (const sql of pools)
    await sql
      .end({ timeout: 3 })
      .catch((error) => cleanupErrors.push(String(error)))
  if (container) {
    await docker('logs', container)
      .then((log) => writeFile(join(evidence, 'postgres.log'), log))
      .catch((error) => cleanupErrors.push(String(error)))
    await docker('rm', '-f', '-v', container).catch((error) =>
      cleanupErrors.push(String(error)),
    )
  }
  await record({
    qualification: 'resource_cleanup',
    status: cleanupErrors.length ? 'fail' : 'pass',
    cleanupErrors,
    failed,
  })
  if (cleanupErrors.length)
    throw new Error('Cleanup incomplete: ' + cleanupErrors.join('; '))
}
