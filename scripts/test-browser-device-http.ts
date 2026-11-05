// Opt-in real HTTP acceptance: the caller owns a disposable, fully migrated loopback database.
// This runner never creates a cluster/container or changes the migration journal.
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import postgres from 'postgres'
import { hashPassword } from '../apps/farm/server/utils/auth/password.ts'
import { pairingHttpProxy } from '../tests/helpers/pairing-http-proxy.ts'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'

const portText = process.env.BROWSER_DEVICE_HTTP_SYNTHETIC_TEST_PORT
const port = Number(portText)
const requestedLedger = process.env.BROWSER_DEVICE_HTTP_TEST_LEDGER
if (
  process.versions.bun ||
  process.argv.length !== 2 ||
  process.env.BROWSER_DEVICE_HTTP_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^\d{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535 ||
  !requestedLedger ||
  !isAbsolute(requestedLedger)
)
  throw new Error(
    'Node, explicit disposable loopback PostgreSQL port and outside-checkout ledger required',
  )
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (process.env.BROWSER_DEVICE_HTTP_TEST_BUILD_HEAD !== sourceHead)
  throw new Error('Fresh coordinator build HEAD marker required')
const checkout = await realpath(new URL('..', import.meta.url))
const ledgerPath = join(
  await realpath(dirname(requestedLedger)),
  basename(requestedLedger),
)
const ledgerRelative = relative(checkout, ledgerPath)
if (!ledgerRelative.startsWith('..' + '/') && !isAbsolute(ledgerRelative))
  throw new Error('Ledger must be outside checkout')
const ledger = await open(
  ledgerPath,
  constants.O_APPEND |
    constants.O_CREAT |
    constants.O_WRONLY |
    constants.O_NOFOLLOW,
  0o600,
)
await ledger.chmod(0o600)
const note = (message: string) =>
  ledger.appendFile(`${new Date().toISOString()} ${message}\n`)
const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 2,
  connect_timeout: 3,
  connection: { statement_timeout: 3000, lock_timeout: 1000 },
})
const prefix = 'browser_http_' + randomUUID().replaceAll('-', '')
const childEnvironment = { ...process.env }
delete childEnvironment.NODE_TLS_REJECT_UNAUTHORIZED
const capabilities = [
  'farm_password_auth',
  'farm_connector_inventory',
  'farm_browser_device_runtime',
] as const
const roles = capabilities.map((_, index) => `${prefix}_${index}`)
const rolePasswords = roles.map(() => randomBytes(24).toString('hex'))
const actors = ['owner', 'admin', 'operator', 'viewer', 'outsider'] as const
const accounts = actors.map((actor) => ({
  actor,
  id: randomUUID(),
  username: actor + '_' + randomBytes(10).toString('hex'),
}))
const password = randomBytes(24).toString('hex')
const farmId = randomUUID(),
  otherFarmId = randomUUID()
const createdRoles: string[] = []
let directory: string | undefined
let app: ChildProcess | undefined
let browser: ChildProcess | undefined
let proxy: ReturnType<typeof pairingHttpProxy> | undefined
let stage = 'fixture validation'
let migrationCount = 0
let failed = false
let interrupted = false
let appLog = ''
const logSecrets = [
  ...rolePasswords,
  password,
  ...accounts.flatMap((actor) => [actor.id, actor.username]),
  farmId,
  otherFarmId,
]
function captureAppLog(chunk: Buffer) {
  if (appLog.length >= 16_384) return
  let text = chunk.toString('utf8')
  for (const secret of logSecrets)
    text = text.replaceAll(secret, '[synthetic-redacted]')
  text = text
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]')
    .replace(
      /(?:set-cookie|cookie|authorization):[^\r\n]*/gi,
      '[header-redacted]',
    )
  appLog += text.slice(0, 16_384 - appLog.length)
}
const interrupt = () => {
  interrupted = true
  app?.kill('SIGTERM')
  if (browser?.pid) {
    try {
      process.kill(-browser.pid, 'SIGTERM')
    } catch {
      /* process already exited */
    }
  }
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const pause = (ms: number) =>
  new Promise<void>((resolvePause) => setTimeout(resolvePause, ms))
function checkInterrupt() {
  if (interrupted) throw new Error('Acceptance interrupted')
}

async function stop(child: ChildProcess | undefined, group: boolean) {
  if (!child?.pid) return
  const signal = (name: NodeJS.Signals) => {
    try {
      if (group) process.kill(-child.pid!, name)
      else if (child.exitCode === null && child.signalCode === null)
        child.kill(name)
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ESRCH'
        )
      )
        throw error
    }
  }
  signal('SIGTERM')
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, 'exit'), pause(3000)])
  }
  // A detached test's browser descendants can outlive its parent; stop the owned process group too.
  if (group || (child.exitCode === null && child.signalCode === null))
    signal('SIGKILL')
  if (child.exitCode === null && child.signalCode === null)
    await Promise.race([once(child, 'exit'), pause(3000)])
  if (child.exitCode === null && child.signalCode === null)
    throw new Error('Owned process did not stop')
}

try {
  const serverEntry = await readFile('apps/farm/.output/server/index.mjs')
  await note(
    `Source HEAD ${sourceHead}; built server entry SHA256 ${createHash('sha256').update(serverEntry).digest('hex')}`,
  )
  await note(
    `Run ${prefix}; caller-owned fixture port ${port}; no cluster/container ownership`,
  )
  const identity = (
    await sql`SELECT current_database() AS db,current_user AS actor`
  )[0]
  assert.equal(identity?.db, 'fixture')
  assert.equal(identity?.actor, 'fixture')
  const catalog = await loadMigrationCatalog()
  const history =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  assert(
    catalog.some((entry) => entry.id === '0016_telemetry_operation_proofs'),
  )
  migrationCount = catalog.length
  await note(
    `Validated exact contiguous migration history: ${migrationCount} entries through ${catalog.at(-1)?.id}`,
  )
  stage = 'restricted fixture setup'
  for (const [index, role] of roles.entries()) {
    const secret = rolePasswords[index]!,
      capability = capabilities[index]!
    await sql.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${capability}`,
    )
    createdRoles.push(role)
  }
  for (const role of roles) {
    const grants = (
      await sql`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_schema_privilege(rolname,'farm','CREATE') AS schema_create FROM pg_roles WHERE rolname=${role}`
    )[0]
    assert(grants)
    assert(Object.values(grants).every((value) => value === false))
  }
  const passwordHash = await hashPassword(password)
  for (const actor of accounts) {
    await sql`INSERT INTO farm.session_accounts(id) VALUES(${actor.id})`
    await sql`INSERT INTO farm.password_credentials(account_id,username,password_hash) VALUES(${actor.id},${actor.username},${passwordHash})`
  }
  await sql`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid),(${otherFarmId}::uuid)`
  for (const actor of accounts) {
    const targetFarm = actor.actor === 'outsider' ? otherFarmId : farmId
    const role = actor.actor === 'outsider' ? 'owner' : actor.actor
    await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${targetFarm}::uuid,${actor.id},${role})`
  }
  await note(
    `Owned LOGIN roles ${roles.join(',')}; synthetic account IDs ${accounts.map((actor) => actor.id).join(',')}; synthetic farms ${farmId},${otherFarmId}; tombstones remain caller-owned disposable database rows`,
  )
  checkInterrupt()
  directory = await mkdtemp(join(tmpdir(), 'open3dfarm-browser-device-https-'))
  await chmod(directory, 0o700)
  await note(`Owned TLS/browser temporary directory ${directory}`)
  const cert = join(directory, 'cert.pem'),
    key = join(directory, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore', timeout: 15_000 },
  )
  await chmod(key, 0o600)
  await chmod(cert, 0o600)
  let appPort = 0
  // The claim-drop control is deliberately unused: this acceptance only exercises browser-device routes.
  proxy = pairingHttpProxy({
    key: await readFile(key),
    cert: await readFile(cert),
    upstreamPort: () => appPort,
    dropControl: randomBytes(32).toString('hex'),
  })
  proxy.requestTimeout = 15_000
  proxy.headersTimeout = 10_000
  proxy.setTimeout(20_000, (socket) => socket.destroy())
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  if (!address || typeof address === 'string')
    throw new Error('TLS fixture did not bind')
  const origin = `https://127.0.0.1:${address.port}`
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const reserved = reservation.address()
  if (!reserved || typeof reserved === 'string')
    throw new Error('App fixture port unavailable')
  appPort = reserved.port
  await new Promise<void>((resolveClose, rejectClose) =>
    reservation.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  const dbUrl = (index: number) =>
    `postgres://${roles[index]}:${rolePasswords[index]}@127.0.0.1:${port}/fixture`
  stage = 'real Nuxt startup'
  const sessionSecret = randomBytes(32).toString('hex')
  logSecrets.push(sessionSecret)
  app = spawn(process.execPath, ['apps/farm/.output/server/index.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...childEnvironment,
      NODE_EXTRA_CA_CERTS: cert,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(appPort),
      NUXT_AUTH_ENABLED: 'true',
      NUXT_AUTH_ORIGIN: origin,
      NUXT_AUTH_SESSION_SECRET: sessionSecret,
      NUXT_AUTH_DATABASE_URL: dbUrl(0),
      NUXT_CONNECTOR_INVENTORY_ENABLED: 'true',
      NUXT_CONNECTOR_INVENTORY_DATABASE_URL: dbUrl(1),
      NUXT_BROWSER_DEVICES_ENABLED: 'true',
      NUXT_BROWSER_DEVICES_DATABASE_URL: dbUrl(2),
      NUXT_CONNECTOR_PAIRING_ENABLED: 'false',
    },
  })
  app.on('error', () => {
    /* startup/exit guard reports a sanitized failure */
  })
  app.stdout?.on('data', captureAppLog)
  app.stderr?.on('data', captureAppLog)
  await note(
    `Owned Nuxt PID ${app.pid}; TLS proxy port ${address.port}; app port ${appPort}`,
  )
  const startupDeadline = Date.now() + 20_000
  while (true) {
    checkInterrupt()
    if (!app.pid || app.exitCode !== null || app.signalCode !== null)
      throw new Error('Built Nuxt exited before readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/healthz`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.status === 200) break
    } catch {
      /* bounded readiness retry */
    }
    if (Date.now() >= startupDeadline)
      throw new Error('Built Nuxt readiness timed out')
    await pause(100)
  }
  const actorEnv: Record<string, string> = {}
  for (const actor of accounts) {
    actorEnv[`BROWSER_DEVICE_HTTP_TEST_${actor.actor.toUpperCase()}_USERNAME`] =
      actor.username
    actorEnv[`BROWSER_DEVICE_HTTP_TEST_${actor.actor.toUpperCase()}_ACCOUNT`] =
      actor.id
  }
  stage = 'real Chromium HTTP acceptance'
  // Secrets go only to the test child environment; no credential URLs, cookies or HTML are logged.
  browser = spawn(
    './node_modules/.bin/playwright',
    [
      'test',
      '--config',
      'playwright.browser-device-http.config.ts',
      '--reporter=line',
    ],
    {
      detached: true,
      stdio: 'inherit',
      env: {
        ...childEnvironment,
        ...actorEnv,
        NODE_EXTRA_CA_CERTS: cert,
        BROWSER_DEVICE_HTTP_TEST_DISPOSABLE: 'yes',
        BROWSER_DEVICE_HTTP_TEST_ORIGIN: origin,
        BROWSER_DEVICE_HTTP_TEST_OUTPUT_DIR: join(directory, 'browser-output'),
        BROWSER_DEVICE_HTTP_TEST_PASSWORD: password,
        BROWSER_DEVICE_HTTP_TEST_FARM_ID: farmId,
        BROWSER_DEVICE_HTTP_TEST_OTHER_FARM_ID: otherFarmId,
        BROWSER_DEVICE_HTTP_TEST_AUTH_ROLE: roles[0],
        BROWSER_DEVICE_HTTP_TEST_INVENTORY_ROLE: roles[1],
        BROWSER_DEVICE_HTTP_TEST_DEVICE_ROLE: roles[2],
      },
    },
  )
  browser.on('error', () => {
    /* exit wait reports a sanitized failure */
  })
  if (!browser.pid) throw new Error('Playwright did not start')
  await note(`Owned Playwright process group ${browser.pid}`)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exit = await Promise.race([
      once(browser, 'exit').then(([code]) => code),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Browser acceptance deadline exceeded')),
          260_000,
        )
      }),
    ])
    checkInterrupt()
    if (exit !== 0) throw new Error('Browser acceptance failed')
  } finally {
    clearTimeout(timer)
  }
  stage = 'complete'
  await note(
    `PASS real built Nuxt HTTPS/Chromium acceptance; exact migration count ${migrationCount}`,
  )
} catch {
  failed = true
  await note(
    `FAIL during ${stage}; sanitized receipt only; browser output removed during cleanup`,
  )
} finally {
  const cleanupFailures: string[] = []
  async function cleanup(name: string, action: () => Promise<void>) {
    try {
      await action()
    } catch {
      cleanupFailures.push(name)
    }
  }
  await cleanup('browser process group', () => stop(browser, true))
  await cleanup('Nuxt child', () => stop(app, false))
  await cleanup('TLS proxy', async () => {
    if (!proxy?.listening) return
    const server = proxy
    const closed = new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    )
    server.closeAllConnections()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('TLS proxy close timeout')),
            3000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  })
  for (const role of createdRoles.reverse())
    await cleanup('restricted LOGIN role ' + role, async () => {
      await sql`DROP ROLE ${sql(role)}`
    })
  await cleanup('admin connection', () => sql.end({ timeout: 3 }))
  if (directory)
    await cleanup('TLS and browser temporary directory', () =>
      rm(directory!, { recursive: true, force: true }),
    )
  if (appLog)
    await cleanup('bounded sanitized app log', () =>
      writeFile(ledgerPath + '.app-log.txt', appLog, { mode: 0o600 }),
    )
  await note(
    `Cleanup ${cleanupFailures.length ? 'INCOMPLETE: ' + cleanupFailures.join(',') : 'complete: owned children, TLS proxy, LOGIN roles and temporary files removed'}; disposable tombstone rows remain caller-owned; PG window NOT released by runner`,
  )
  await ledger.close()
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (failed || cleanupFailures.length) process.exitCode = 1
}
