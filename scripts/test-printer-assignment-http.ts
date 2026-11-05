// Explicit opt-in only: caller owns the disposable, already migrated loopback database.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import postgres from 'postgres'
import { hashPassword } from '../apps/farm/server/utils/auth/password.ts'
import { pairingHttpProxy } from '../tests/helpers/pairing-http-proxy.ts'
import { testPrinterAssignmentRolePolicy } from '../tests/helpers/printer-assignment-role-policy-real.ts'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'

const ledger = process.env.PRINTER_HTTP_TEST_LEDGER
const portText = process.env.PRINTER_HTTP_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.versions.bun ||
  !process.versions.node.startsWith('24.') ||
  process.argv.length !== 2 ||
  !ledger ||
  !isAbsolute(ledger) ||
  process.env.PRINTER_HTTP_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^[0-9]{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Node and an explicitly disposable loopback PostgreSQL fixture are required',
  )
const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 2,
  connect_timeout: 3,
})
const prefix = `printer_http_${randomUUID().replaceAll('-', '')}`
const roles = [`${prefix}_auth`, `${prefix}_printer`]
const passwords = roles.map(() => randomBytes(24).toString('hex'))
const password = randomBytes(24).toString('hex')
const users = ['owner', 'admin', 'viewer', 'operator'].map((role) => ({
  role,
  id: randomUUID(),
  username: `${role}_${randomBytes(8).toString('hex')}`,
}))
const farm = randomUUID(),
  otherFarm = randomUUID(),
  agent = randomUUID(),
  foreignAgent = randomUUID(),
  revokedAgent = randomUUID()
const directory = await mkdtemp(join(tmpdir(), 'open3dfarm-printer-http-'))
const created: string[] = []
let app: ReturnType<typeof spawn> | undefined
let browser: ReturnType<typeof spawn> | undefined
let proxy: ReturnType<typeof pairingHttpProxy> | undefined
let stage = 'setup'
try {
  await appendFile(
    ledger,
    `Printer HTTP temporary directory: ${directory}\nPrinter HTTP roles: ${roles.join(', ')}\n`,
  )
  const identity = (
    await sql`SELECT current_database() AS db, current_user AS actor`
  )[0]
  assert.equal(identity?.db, 'fixture')
  assert.equal(identity?.actor, 'fixture')
  const catalog = await loadMigrationCatalog()
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [
      '0001_connector_enrollments',
      '0002_telemetry_events',
      '0003_runtime_capabilities',
      '0004_account_sessions',
      '0005_password_auth',
      '0006_farm_memberships',
      '0007_pairing_requests',
      '0008_pairing_proofs',
      '0009_pairing_proof_gates',
      '0010_connector_credentials',
      '0011_connector_revocations',
      '0012_connector_inventory',
      '0013_browser_device_registry',
      '0014_connector_credential_proofs',
      '0015_printer_ownership',
      '0016_telemetry_operation_proofs',
      '0017_signalling_authorization',
    ],
  )
  const history =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  await appendFile(
    ledger,
    `Validated migration journal: ${JSON.stringify(history)}\n`,
  )
  await testPrinterAssignmentRolePolicy(sql, port, ledger)
  for (const [index, capability] of [
    'farm_password_auth',
    'farm_printer_ownership',
  ].entries()) {
    const role = roles[index]!,
      secret = passwords[index]!
    await sql.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${capability}`,
    )
    created.push(role)
  }
  await sql`INSERT INTO farm.farms(id) VALUES(${farm}::uuid),(${otherFarm}::uuid)`
  const passwordHash = await hashPassword(password)
  for (const user of users) {
    await sql`INSERT INTO farm.session_accounts(id) VALUES(${user.id})`
    await sql`INSERT INTO farm.password_credentials(account_id,username,password_hash) VALUES(${user.id},${user.username},${passwordHash})`
    await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farm}::uuid,${user.id},${user.role})`
  }
  for (const [id, farmId] of [
    [agent, farm],
    [foreignAgent, otherFarm],
    [revokedAgent, farm],
  ] as const) {
    await sql`INSERT INTO farm.connector_enrollments(agent_id,farm_id,public_key_spki,fingerprint) VALUES(${id}::uuid,${farmId}::uuid,${'A'.repeat(59)},${'SHA256:' + 'A'.repeat(43)})`
    await sql`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${id}::uuid`
  }
  await sql`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${revokedAgent}::uuid`
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
    { stdio: 'ignore' },
  )
  let appPort = 0
  proxy = pairingHttpProxy({
    key: await readFile(key),
    cert: await readFile(cert),
    upstreamPort: () => appPort,
    dropControl: randomBytes(24).toString('hex'),
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === 'string')
    throw new Error('Proxy bind failed')
  const origin = `https://127.0.0.1:${proxyAddress.port}`
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const appAddress = reservation.address()
  if (!appAddress || typeof appAddress === 'string')
    throw new Error('App port reservation failed')
  appPort = appAddress.port
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  const dbUrl = (index: number) =>
    `postgres://${roles[index]}:${passwords[index]}@127.0.0.1:${port}/fixture`
  stage = 'app startup'
  app = spawn(process.execPath, ['apps/farm/.output/server/index.mjs'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(appPort),
      NUXT_AUTH_ENABLED: 'true',
      NUXT_AUTH_ORIGIN: origin,
      NUXT_AUTH_SESSION_SECRET: randomBytes(32).toString('hex'),
      NUXT_AUTH_DATABASE_URL: dbUrl(0),
      NUXT_PRINTER_ASSIGNMENTS_ENABLED: 'true',
      NUXT_PRINTER_ASSIGNMENTS_DATABASE_URL: dbUrl(1),
    },
  })
  const deadline = Date.now() + 15000
  while (true) {
    if (app.exitCode !== null || app.signalCode !== null)
      throw new Error('Built app exited during startup')
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${appPort}/healthz`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        break
    } catch {
      /* startup */
    }
    if (Date.now() >= deadline) throw new Error('Built app startup timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  stage = 'browser acceptance'
  browser = spawn(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'playwright.printer-assignment-http.config.ts',
      '--reporter=line',
    ],
    {
      stdio: 'inherit',
      detached: true,
      env: {
        ...process.env,
        PRINTER_HTTP_TEST_DISPOSABLE: 'yes',
        PRINTER_HTTP_TEST_ORIGIN: origin,
        PRINTER_HTTP_TEST_PASSWORD: password,
        PRINTER_HTTP_TEST_FARM: farm,
        PRINTER_HTTP_TEST_OTHER_FARM: otherFarm,
        PRINTER_HTTP_TEST_AGENT: agent,
        PRINTER_HTTP_TEST_FOREIGN_AGENT: foreignAgent,
        PRINTER_HTTP_TEST_REVOKED_AGENT: revokedAgent,
        PRINTER_HTTP_TEST_OWNER: users[0]!.username,
        PRINTER_HTTP_TEST_OWNER_ACCOUNT: users[0]!.id,
        PRINTER_HTTP_TEST_ADMIN_ACCOUNT: users[1]!.id,
        PRINTER_HTTP_TEST_PRINTER_ROLE: roles[1],
        PRINTER_HTTP_TEST_AUTH_ROLE: roles[0],
        PRINTER_HTTP_TEST_ADMIN: users[1]!.username,
        PRINTER_HTTP_TEST_VIEWER: users[2]!.username,
        PRINTER_HTTP_TEST_OPERATOR: users[3]!.username,
        PRINTER_HTTP_TEST_OUTPUT_DIR: join(directory, 'playwright-output'),
      },
    },
  )
  const outcome = await Promise.race([
    once(browser, 'exit').then(([code]) => code),
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 120000)
      timer.unref()
    }),
  ])
  if (outcome !== 0) throw new Error(`Browser acceptance failed: ${outcome}`)
  stage = 'complete'
} catch (error) {
  await appendFile(ledger, `Printer HTTP fixture failed during ${stage}.\n`)
  throw error
} finally {
  const failed: string[] = []
  async function cleanup(name: string, fn: () => Promise<void>) {
    try {
      await fn()
    } catch {
      failed.push(name)
    }
  }
  async function stop(
    child: ReturnType<typeof spawn> | undefined,
    group: boolean,
  ) {
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !child.pid
    )
      return
    const exited = once(child, 'exit')
    if (group) process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
    const done = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    if (!done) {
      if (group) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
      await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Child exit timed out')), 3000),
        ),
      ])
    }
  }
  await cleanup('browser', () => stop(browser, true))
  await cleanup('app', () => stop(app, false))
  await cleanup('proxy', async () => {
    if (proxy?.listening) {
      const closing = new Promise<void>((resolve, reject) =>
        proxy!.close((error) => (error ? reject(error) : resolve())),
      )
      proxy.closeAllConnections()
      await Promise.race([
        closing,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Proxy close timed out')), 3000),
        ),
      ])
    }
  })
  for (const role of created.reverse())
    await cleanup('role', async () => {
      await sql`DROP ROLE ${sql(role)}`
    })
  await cleanup('database connection', async () => {
    await sql.end({ timeout: 3 })
  })
  await cleanup('temporary directory', async () => {
    await rm(directory, { recursive: true, force: true })
  })
  await appendFile(
    ledger,
    `Printer HTTP cleanup: ${failed.length ? 'failed: ' + failed.join(', ') : 'complete'}; disposable database rows remain caller-owned.\n`,
  )
  if (failed.length)
    throw new Error('Fixture cleanup incomplete; inspect task ledger')
}
