// Explicit opt-in only: the caller owns a dedicated, disposable, already migrated loopback database.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PostgresCredentials } from '../apps/farm/server/storage/postgres-credentials.ts'
import { isAbsolute, join } from 'node:path'
import postgres from 'postgres'
import { hashPassword } from '../apps/farm/server/utils/auth/password.ts'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'

const ledger = process.env.PAIRING_HTTP_TEST_LEDGER
const portText = process.env.PAIRING_HTTP_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  !ledger ||
  !isAbsolute(ledger) ||
  process.env.PAIRING_HTTP_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^[0-9]{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    'Explicit disposable loopback PostgreSQL fixture port required',
  )
const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  max: 2,
  connect_timeout: 3,
})
const prefix = 'http_fixture_' + randomUUID().replaceAll('-', '')
const roles = ['auth', 'pair', 'proof', 'revoke', 'inventory'].map(
  (name) => prefix + '_' + name,
)
const capabilities = [
  'farm_password_auth',
  'farm_pairing_runtime',
  'farm_pairing_proof_runtime',
  'farm_connector_revoker',
  'farm_connector_inventory',
]
const secrets = roles.map(() => randomBytes(24).toString('hex'))
const account = randomUUID(),
  farm = randomUUID(),
  otherFarm = randomUUID()
const username = 'u' + randomBytes(12).toString('hex'),
  password = randomBytes(24).toString('hex')
const adminAccount = randomUUID(),
  operatorAccount = randomUUID()
const adminUsername = 'a' + randomBytes(12).toString('hex'),
  operatorUsername = 'o' + randomBytes(12).toString('hex')
const directory = await mkdtemp(join(tmpdir(), 'open3dfarm-pairing-http-'))
const created: string[] = []
let app: ReturnType<typeof spawn> | undefined
let proxy: ReturnType<typeof createHttpsServer> | undefined
try {
  await appendFile(
    ledger!,
    `Fixture temporary directory: ${directory}\nFixture roles: ${roles.join(', ')}\n`,
  )
  const actor = (
    await sql`SELECT current_database() AS db, current_user AS actor`
  )[0]
  assert.equal(actor?.db, 'fixture')
  assert.equal(actor?.actor, 'fixture')
  const catalog = await loadMigrationCatalog()
  assert.equal(catalog.at(-1)?.id, '0012_connector_inventory')
  const history =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), catalog.length)
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index]!,
      capability = capabilities[index]!,
      secret = secrets[index]!
    await sql.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${capability}`,
    )
    created.push(role)
  }
  await sql`INSERT INTO farm.session_accounts(id) VALUES(${account})`
  await sql`INSERT INTO farm.password_credentials(account_id,username,password_hash) VALUES(${account},${username},${await hashPassword(password)})`
  for (const [id, name] of [
    [adminAccount, adminUsername],
    [operatorAccount, operatorUsername],
  ] as const) {
    await sql`INSERT INTO farm.session_accounts(id) VALUES(${id})`
    await sql`INSERT INTO farm.password_credentials(account_id,username,password_hash) VALUES(${id},${name},${await hashPassword(password)})`
  }
  await sql`INSERT INTO farm.farms(id) VALUES(${farm}::uuid),(${otherFarm}::uuid)`
  await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farm}::uuid,${account},'owner')`
  await sql`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farm}::uuid,${adminAccount},'admin'),(${farm}::uuid,${operatorAccount},'operator')`
  const cert = join(directory, 'cert.pem'),
    tlsKey = join(directory, 'tls-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      tlsKey,
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
  const keys = generateKeyPairSync('ed25519')
  const keyPath = join(directory, 'signing.pem'),
    publicPath = join(directory, 'public.pem')
  await writeFile(
    keyPath,
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  )
  await writeFile(
    publicPath,
    keys.publicKey.export({ type: 'spki', format: 'pem' }),
  )
  // Reserve an OS-assigned port for the local HTTPS proxy and keep it bound throughout the run.
  let appPort = 0
  const dropControl = randomBytes(24).toString('hex')
  let dropped = false
  proxy = createHttpsServer(
    { key: await readFile(tlsKey), cert: await readFile(cert) },
    (req, res) => {
      const drop =
        !dropped &&
        req.url === '/api/connector-pairing/claim' &&
        req.headers['x-fixture-drop'] === dropControl
      const headers = { ...req.headers }
      delete headers['x-fixture-drop']
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: appPort,
          path: req.url,
          method: req.method,
          headers,
        },
        (reply) => {
          if (drop && reply.statusCode === 200) {
            dropped = true
            reply.resume()
            reply.once('end', () => res.destroy())
            return
          }
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
    },
  )
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  if (!address || typeof address === 'string')
    throw new Error('Proxy did not bind')
  const origin = `https://127.0.0.1:${address.port}`
  // The app port is chosen by an ephemeral listener, released immediately before app startup.
  const { createServer } = await import('node:net')
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const local = reservation.address()
  if (!local || typeof local === 'string')
    throw new Error('App port unavailable')
  appPort = local.port
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  const dbUrl = (index: number) =>
    `postgres://${roles[index]}:${secrets[index]}@127.0.0.1:${port}/fixture`
  const authFixture = postgres(dbUrl(0), { max: 1, connect_timeout: 3 })
  let expiredSessionId: string | null
  try {
    const credentials = new PostgresCredentials(authFixture)
    const snapshot = await credentials.find(username)
    if (!snapshot) throw new Error('Synthetic credentials unavailable')
    expiredSessionId = await credentials.issue(
      snapshot,
      Date.now() - 2000,
      1000,
    )
  } finally {
    await authFixture.end({ timeout: 3 })
  }
  if (!expiredSessionId)
    throw new Error('Synthetic expired session unavailable')
  const appRequire = createRequire(
    new URL('../apps/farm/package.json', import.meta.url),
  )
  const nuxtRequire = createRequire(appRequire.resolve('nuxt'))
  const iron = await import(
    pathToFileURL(nuxtRequire.resolve('iron-webcrypto')).href
  )
  const sessionSecret = randomBytes(32).toString('hex')
  const expiredCookie: string = await iron.seal(
    { nuxt: 1, id: randomUUID(), data: { sessionRecordId: expiredSessionId } },
    sessionSecret,
    { ...iron.defaults, ttl: 8 * 60 * 60 * 1000 },
  )
  app = spawn('node', ['apps/farm/.output/server/index.mjs'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(appPort),
      NUXT_AUTH_ENABLED: 'true',
      NUXT_AUTH_ORIGIN: origin,
      NUXT_AUTH_SESSION_SECRET: sessionSecret,
      NUXT_AUTH_DATABASE_URL: dbUrl(0),
      NUXT_CONNECTOR_INVENTORY_ENABLED: 'true',
      NUXT_CONNECTOR_INVENTORY_DATABASE_URL: dbUrl(4),
      NUXT_CONNECTOR_PAIRING_ENABLED: 'true',
      NUXT_CONNECTOR_PAIRING_ORIGIN: origin,
      NUXT_CONNECTOR_PAIRING_DATABASE_URL: dbUrl(1),
      NUXT_CONNECTOR_PAIRING_PROOF_DATABASE_URL: dbUrl(2),
      NUXT_CONNECTOR_PAIRING_REVOCATION_DATABASE_URL: dbUrl(3),
      NUXT_CONNECTOR_PAIRING_AUDIENCE: 'open3dfarmmanager:pairing',
      NUXT_CONNECTOR_PAIRING_ISSUER: origin,
      NUXT_CONNECTOR_PAIRING_SIGNING_KEY_ID: 'fixture',
      NUXT_CONNECTOR_PAIRING_SIGNING_KEY_PATH: keyPath,
      NUXT_CONNECTOR_PAIRING_TOKEN_TTL_SECONDS: '300',
    },
  })
  const deadline = Date.now() + 15000
  while (true) {
    if (app.exitCode !== null)
      throw new Error('Built app exited during startup')
    try {
      if ((await fetch(`http://127.0.0.1:${appPort}/healthz`)).ok) break
    } catch {
      /* startup */
    }
    if (Date.now() >= deadline)
      throw new Error('Built app did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const test = spawn(
    './node_modules/.bin/playwright',
    [
      'test',
      '--config',
      'playwright.pairing-http.config.ts',
      '--reporter=line',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: cert,
        PAIRING_HTTP_TEST_DISPOSABLE: 'yes',
        PAIRING_HTTP_TEST_OUTPUT_DIR: join(directory, 'playwright-output'),
        PAIRING_HTTP_TEST_ORIGIN: origin,
        PAIRING_HTTP_TEST_USERNAME: username,
        PAIRING_HTTP_TEST_ADMIN_USERNAME: adminUsername,
        PAIRING_HTTP_TEST_OPERATOR_USERNAME: operatorUsername,
        PAIRING_HTTP_TEST_OWNER_ACCOUNT: account,
        PAIRING_HTTP_TEST_ADMIN_ACCOUNT: adminAccount,
        PAIRING_HTTP_TEST_PASSWORD: password,
        PAIRING_HTTP_TEST_FARM_ID: farm,
        PAIRING_HTTP_TEST_OTHER_FARM_ID: otherFarm,
        PAIRING_HTTP_TEST_PUBLIC_KEY_FILE: publicPath,
        PAIRING_HTTP_TEST_KEY_ID: 'fixture',
        PAIRING_HTTP_TEST_DROP_CONTROL: dropControl,
        PAIRING_HTTP_TEST_EXPIRED_COOKIE: expiredCookie,
      },
    },
  )
  const [code] = await once(test, 'exit')
  if (code !== 0) throw new Error('Pairing HTTP acceptance failed')
} finally {
  const failed: string[] = []
  async function cleanup(name: string, action: () => Promise<void>) {
    try {
      await action()
    } catch {
      failed.push(name)
    }
  }
  await cleanup('app', async () => {
    if (!app || app.exitCode !== null || app.signalCode !== null) return
    const exited = once(app, 'exit')
    app.kill('SIGTERM')
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    if (!stopped) {
      app.kill('SIGKILL')
      await exited
    }
  })
  await cleanup('proxy', async () => {
    if (proxy?.listening)
      await new Promise<void>((resolve, reject) =>
        proxy!.close((error) => (error ? reject(error) : resolve())),
      )
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
    ledger!,
    `Fixture cleanup: ${failed.length ? 'failed: ' + failed.join(', ') : 'complete'}; disposable database rows remain caller-owned.\n`,
  )
  if (failed.length)
    throw new Error('Fixture cleanup incomplete; inspect task ledger')
}
