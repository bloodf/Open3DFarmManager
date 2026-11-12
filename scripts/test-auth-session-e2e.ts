// Explicit test-only runner for tests/e2e/auth-lockout-session.spec.ts. Never accepts a
// database URL or an existing container. Needs a built app: pnpm --dir apps/farm build.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const image = process.env.AUTH_E2E_IMAGE
if (
  process.argv.length !== 2 ||
  process.env.AUTH_E2E_ADMITTED !== 'yes' ||
  !image ||
  !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(image)
)
  throw new Error(
    'AUTH_E2E_ADMITTED=yes and a locally available digest-pinned PostgreSQL 17 AUTH_E2E_IMAGE required',
  )
await access(new URL('../apps/farm/.output/server/index.mjs', import.meta.url))
const id = randomUUID()
const name = 'o3dfm-auth-e2e-' + id
const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()
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

let created = false
try {
  // Fails rather than pulling: image ownership stays with its owner.
  await docker('image', 'inspect', image)
  const dbPort = await freePort(process.env.AUTH_E2E_DB_PORT)
  const appPort = await freePort(process.env.AUTH_E2E_APP_PORT)
  const tlsPort = await freePort(process.env.AUTH_E2E_TLS_PORT)
  created = true
  await docker(
    ...['create', '--name', name, '--pull', 'never', '--read-only'],
    ...['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'],
    ...['--user', 'postgres', '--cpus', '2', '--memory', '2g'],
    ...['--label', 'org.open3dfarmmanager.auth-e2e=' + id],
    ...['--tmpfs', '/var/lib/postgresql/data:rw,mode=1777'],
    ...['--tmpfs', '/var/run/postgresql:rw,mode=1777'],
    ...['--tmpfs', '/tmp:rw,mode=1777'],
    ...['-p', `127.0.0.1:${dbPort}:5432`],
    ...['-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture'],
    ...['-e', 'POSTGRES_HOST_AUTH_METHOD=trust'],
    ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
    image,
  )
  await docker('start', name)
  await docker(
    ...['exec', name, 'sh', '-c'],
    'n=0; until pg_isready -U fixture -d fixture >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
  )
  const mapping = await docker('port', name, '5432/tcp')
  assert.equal(mapping.split('\n')[0], `127.0.0.1:${dbPort}`)
  const migrated = await run(
    process.execPath,
    ['scripts/migrate-disposable-db.ts', 'up'],
    {
      MIGRATION_SYNTHETIC_TEST_DISPOSABLE: 'yes',
      MIGRATION_SYNTHETIC_TEST_PORT: String(dbPort),
    },
  )
  assert.equal(migrated, 0, 'Migrations failed')
  process.exitCode = await run(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'playwright.auth-session.config.ts'],
    {
      AUTH_E2E_DISPOSABLE: 'yes',
      AUTH_E2E_DB_PORT: String(dbPort),
      AUTH_E2E_APP_PORT: String(appPort),
      AUTH_E2E_TLS_PORT: String(tlsPort),
    },
  )
} finally {
  if (created) {
    try {
      await docker('rm', '-f', name)
      assert.equal(await docker('ps', '-aq', '--filter', `name=^${name}$`), '')
    } catch {
      process.exitCode = 1
      console.error('Owned container cleanup incomplete: ' + name)
    }
  }
}
