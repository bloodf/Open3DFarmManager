// Explicit test-only runner for tests/e2e/auth-lockout-session.spec.ts.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  type DockerCommand,
} from '../tests/helpers/disposable-postgres.ts'

const exec = promisify(execFile)
const isDocker = process.env.OPENFARM_PG === 'docker'
const image = process.env.AUTH_E2E_IMAGE
if (
  process.argv.length !== 2 ||
  (isDocker && process.env.AUTH_E2E_ADMITTED !== 'yes') ||
  (isDocker && (!image || !POSTGRES_IMAGE_PATTERN.test(image)))
)
  throw new Error('AUTH_E2E_ADMITTED=yes required')
const id = randomUUID()
const name = 'o3dfm-auth-e2e-' + id

let dockerCmd: DockerCommand | undefined
if (isDocker) {
  dockerCmd = async (...args: string[]) =>
    (
      await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
    ).stdout.trim()
}

async function freePort(requested?: string): Promise<number> {
  if (requested) {
    assert.match(requested, /^[0-9]{4,5}$/)
    return Number(requested)
  }
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
const run = (command: string, args: string[], env: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })

const built = await run(
  'npm',
  ['run', 'build', '-w', '@open3dfarmmanager/farm'],
  {},
)
assert.equal(built, 0, 'Farm app build failed')

const dbPort = await freePort(process.env.AUTH_E2E_DB_PORT)
const appPort = await freePort(process.env.AUTH_E2E_APP_PORT)
const tlsPort = await freePort(process.env.AUTH_E2E_TLS_PORT)
const authPassword = randomBytes(32).toString('hex')

const database = disposablePostgres({
  isolated: true,
  name,
  labelKey: 'org.open3dfarmmanager.auth-e2e',
  labelValue: id,
  port: dbPort,
  through: false,
  ...(isDocker ? { docker: dockerCmd, image } : {}),
})

try {
  await database.start()

  const migrated = await run(
    process.execPath,
    ['scripts/migrate-disposable-db.ts', 'up'],
    {
      PGPASSWORD: database.password,
      MIGRATION_SYNTHETIC_TEST_DISPOSABLE: 'yes',
      MIGRATION_SYNTHETIC_TEST_PORT: String(dbPort),
    },
  )
  assert.equal(migrated, 0, 'Migrations failed')
  process.exitCode = await run(
    'npm',
    [
      'exec',
      '--offline',
      '--',
      'playwright',
      'test',
      '-c',
      'playwright.auth-session.config.ts',
    ],
    {
      PGPASSWORD: database.password,
      AUTH_E2E_ROLE_PASSWORD: authPassword,
      AUTH_E2E_DISPOSABLE: 'yes',
      AUTH_E2E_DB_PORT: String(dbPort),
      AUTH_E2E_APP_PORT: String(appPort),
      AUTH_E2E_TLS_PORT: String(tlsPort),
    },
  )
} finally {
  try {
    await database.stop()
  } catch {
    process.exitCode = 1
    console.error('Fixture cleanup incomplete: ' + name)
  }
}
