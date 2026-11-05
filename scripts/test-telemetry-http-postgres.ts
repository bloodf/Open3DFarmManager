// Opt-in disposable fixture: actual PostgreSQL and synthetic-only HTTP clients.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import postgres from 'postgres'
import { generateKeyPairSync } from 'node:crypto'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from './db/migrations.ts'
import { PostgresPairing } from '../apps/farm/server/storage/postgres-pairing.ts'
import { PostgresPairingProof } from '../apps/farm/server/storage/postgres-pairing-proof.ts'
import { PostgresPrinterOwnership } from '../apps/farm/server/storage/postgres-printer-ownership.ts'
import { PostgresConnectorRevocation } from '../apps/farm/server/storage/postgres-connector-revocation.ts'
import { createTelemetryHttpRuntime } from '../apps/farm/server/services/telemetry-http-runtime.ts'
import { ConnectorIdentity } from '../packages/connector/src/identity/store.ts'
import { TelemetryQueue } from '../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../packages/connector/src/cloud/drain.ts'
import { createAuthenticatedTelemetrySender } from '../packages/connector/src/cloud/authenticated-http-telemetry.ts'
import { startBuiltTelemetryFixture } from '../tests/helpers/telemetry-built-harness.ts'

const builtMode = process.env.TELEMETRY_HTTP_TEST_BUILT === 'yes'
const ledgerPath = process.env.TELEMETRY_HTTP_SYNTHETIC_LEDGER
if (
  !ledgerPath ||
  !isAbsolute(ledgerPath) ||
  !relative(process.cwd(), ledgerPath).startsWith('..')
)
  throw new Error('External synthetic resource ledger required')
const portText = process.env.TELEMETRY_HTTP_SYNTHETIC_TEST_PORT
const port = Number(portText)
if (
  process.argv.length !== 2 ||
  process.env.TELEMETRY_HTTP_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !portText ||
  !/^[0-9]{4,5}$/.test(portText) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL port required')
const prefix = 'telemetry_http_' + randomUUID().replaceAll('-', '')
const roles = [
  { name: prefix, group: 'farm_connector_telemetry_writer' },
  { name: prefix + '_pair', group: 'farm_pairing_runtime' },
  { name: prefix + '_owner', group: 'farm_printer_ownership' },
  { name: prefix + '_revoke', group: 'farm_connector_revoker' },
  { name: prefix + '_bad', group: 'farm_connector_telemetry_writer' },
]
const options = {
  host: '127.0.0.1',
  port,
  database: 'fixture',
  password: '',
  ssl: false as const,
  connect_timeout: 3,
}
const admin = postgres({ ...options, username: 'fixture', max: 4 })
const pools: ReturnType<typeof postgres>[] = []
const created: string[] = []
let directory: string | undefined
let queue: TelemetryQueue | undefined
let server: ReturnType<typeof createServer> | undefined
let built: Awaited<ReturnType<typeof startBuiltTelemetryFixture>> | undefined
try {
  const identity = (
    await admin`SELECT current_database() AS db,current_user AS actor`
  )[0]
  assert.equal(identity?.db, 'fixture')
  assert.equal(identity?.actor, 'fixture')
  const catalog = (await loadMigrationCatalog()).slice(0, 16)
  assert.equal(catalog.length, 16)
  const history =
    await admin`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...history]), 16)
  for (const role of roles) {
    await admin`CREATE ROLE ${admin(role.name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(role.group)}`
    created.push(role.name)
    await appendFile(
      ledgerPath,
      JSON.stringify({ resource: 'database-role', name: role.name }) + '\n',
      { mode: 0o600 },
    )
  }
  function connect(username: string) {
    const sql = postgres({
      ...options,
      username,
      max: 3,
      idle_timeout: 20,
      connection: { statement_timeout: 2000, lock_timeout: 1000 },
    })
    pools.push(sql)
    return sql
  }
  const sql = connect(prefix),
    pairSql = connect(prefix + '_pair'),
    ownerSql = connect(prefix + '_owner'),
    revokeSql = connect(prefix + '_revoke'),
    badSql = connect(prefix + '_bad')
  directory = await mkdtemp(join(tmpdir(), 'o3dfm-telemetry-http-real-'))
  await appendFile(
    ledgerPath,
    JSON.stringify({ resource: 'fixture-directory', path: directory }) + '\n',
    { mode: 0o600 },
  )
  const keyFile = join(directory, 'keys.json')
  const keys = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  if (!('privateKey' in keys)) throw new Error('Expected key pair')
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', keys.publicKey),
  ).toString('base64')
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----\n`
  await writeFile(keyFile, JSON.stringify({ fixture: pem }), { mode: 0o600 })
  const agentKey = generateKeyPairSync('ed25519').privateKey
  const agent = new ConnectorIdentity(agentKey)
  let handler:
    | Awaited<ReturnType<typeof createTelemetryHttpRuntime>>
    | undefined
  let origin: string
  const audience = 'open3dfarmmanager:connector'
  if (builtMode) {
    built = await startBuiltTelemetryFixture({
      directory,
      keyFile,
      sqlPort: port,
      sqlUser: prefix,
      issuer: 'https://farm.example',
      audience,
      ledgerPath,
    })
    origin = built.origin
  } else {
    let dropAcknowledgement = true
    server = createServer(async (req, res) => {
      if (!handler) {
        res.writeHead(503)
        res.end()
        return
      }
      const result = await handler({ '~app': { node: { req } } })
      if (
        req.url === '/api/connector/telemetry' &&
        result.status === 200 &&
        dropAcknowledgement
      ) {
        dropAcknowledgement = false
        res.destroy()
        return
      }
      res.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(result.body))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP listener')
    origin = `http://127.0.0.1:${address.port}`
    await appendFile(
      ledgerPath,
      JSON.stringify({ resource: 'loopback-server', port: address.port }) +
        '\n',
      { mode: 0o600 },
    )
  }
  const config = {
    origin,
    issuer: 'https://farm.example',
    audience,
    ttlSeconds: 300,
    proofTtlMs: 30000,
  }
  handler = await createTelemetryHttpRuntime({
    sql,
    keyFile,
    config,
    bodyTimeoutMs: 5000,
  })
  const denyBad = () =>
    assert.rejects(
      createTelemetryHttpRuntime({
        sql: badSql,
        keyFile,
        config,
        bodyTimeoutMs: 5000,
      }),
    )
  await admin`GRANT farm_printer_ownership TO ${admin(prefix + '_bad')}`
  await denyBad()
  await admin`REVOKE farm_printer_ownership FROM ${admin(prefix + '_bad')}`
  const bridge = prefix + '_bridge',
    elevated = prefix + '_elevated'
  await admin`CREATE ROLE ${admin(bridge)} NOLOGIN NOINHERIT`
  created.push(bridge)
  await appendFile(
    ledgerPath,
    JSON.stringify({ resource: 'database-role', name: bridge }) + '\n',
    { mode: 0o600 },
  )
  await admin`GRANT farm_printer_ownership TO ${admin(bridge)}`
  await admin`GRANT ${admin(bridge)} TO ${admin(prefix + '_bad')}`
  await denyBad()
  await admin`REVOKE ${admin(bridge)} FROM ${admin(prefix + '_bad')}`
  await admin`CREATE ROLE ${admin(elevated)} NOLOGIN CREATEDB`
  created.push(elevated)
  await appendFile(
    ledgerPath,
    JSON.stringify({ resource: 'database-role', name: elevated }) + '\n',
    { mode: 0o600 },
  )
  await admin`GRANT ${admin(elevated)} TO ${admin(prefix + '_bad')}`
  await denyBad()
  await admin`REVOKE ${admin(elevated)} FROM ${admin(prefix + '_bad')}`
  try {
    await admin`ALTER DATABASE fixture OWNER TO ${admin(prefix + '_bad')}`
    await denyBad()
  } finally {
    await admin`ALTER DATABASE fixture OWNER TO fixture`
  }
  try {
    await admin`ALTER SCHEMA farm OWNER TO ${admin(prefix + '_bad')}`
    await denyBad()
  } finally {
    await admin`ALTER SCHEMA farm OWNER TO fixture`
  }
  try {
    await admin`ALTER TABLE farm.printer_assignments OWNER TO ${admin(prefix + '_bad')}`
    await denyBad()
  } finally {
    await admin`ALTER TABLE farm.printer_assignments OWNER TO fixture`
  }
  const now = Date.now(),
    actor = randomUUID(),
    farmId = randomUUID()
  await admin`INSERT INTO farm.session_accounts(id) VALUES(${actor})`
  await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES(${actor},${actor},0,${now},${now},${now + 100000})`
  await admin`INSERT INTO farm.farms(id) VALUES(${farmId}::uuid)`
  await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES(${farmId}::uuid,${actor},'owner')`
  const binding = { origin, audience: 'open3dfarmmanager:pairing' }
  const pairing = new PostgresPairing(pairSql, binding)
  const proof = new PostgresPairingProof(admin, binding)
  const started = await pairing.start({
    public_key_spki: agent.publicKeySpki,
    platform: 'linux',
    version: '0.0.1',
  })
  if (!started.ok) throw new Error('Pairing fixture failed')
  const challenge = await proof.issue({
    device_code: started.response.device_code,
  })
  if (!challenge.ok) throw new Error('Pairing challenge failed')
  const completion = await proof.complete({
    device_code: started.response.device_code,
    challenge: challenge.challenge,
    signature: agent.signPairingProof({
      challenge: challenge.challenge,
      expectedOrigin: origin,
      expectedAudience: binding.audience,
      now: Date.now(),
    }),
  })
  assert.equal(completion.ok, true)
  const subject = {
    sessionRecordId: actor,
    policy: { idleTimeoutMs: 90000 },
    farmId,
  }
  const decision = await pairing.decide({
    ...subject,
    decision: 'approve',
    request: {
      user_code: started.response.user_code,
      farm_id: farmId,
      expected_fingerprint: agent.fingerprint,
    },
  })
  assert.equal(decision.ok, true)
  const claimed = await pairing.claim(
    { device_code: started.response.device_code },
    {
      issuer: config.issuer,
      audience,
      kid: 'fixture',
      privateKey: keys.privateKey,
      ttlSeconds: 300,
    },
  )
  if (!claimed.ok || claimed.status !== 'approved')
    throw new Error('Credential fixture failed')
  const owner = new PostgresPrinterOwnership(ownerSql)
  assert.equal(
    (
      await owner.register({
        ...subject,
        agentId: claimed.agent_id,
        printerKey: 'simulator',
      })
    ).ok,
    true,
  )
  let eventId: string
  let sender: ReturnType<typeof createAuthenticatedTelemetrySender> | undefined
  const clientFixture = {
    token: claimed.device_token,
    agentId: claimed.agent_id,
    farmId,
    privateKey: agentKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
  if (built) {
    eventId = await built.runClient(clientFixture, 'deliver')
  } else {
    queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    eventId = queue.enqueue(
      {
        printerKey: 'simulator',
        state: 'idle',
        progress: 0,
        observedAt: Date.now(),
      },
      Date.now(),
    ).eventId
    sender = createAuthenticatedTelemetrySender({
      endpoint: origin + '/api/connector/telemetry',
      token: claimed.device_token,
      agentId: claimed.agent_id,
      farmId,
      audience,
      timeoutMs: 5000,
      allowLoopbackHttpForTests: true,
      identity: agent,
    })
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          sender,
          Date.now,
          new AbortController().signal,
        )
      ).status,
      'retained',
    )
    assert.equal(queue.depth, 1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          sender,
          Date.now,
          new AbortController().signal,
        )
      ).status,
      'delivered',
    )
    assert.equal(queue.depth, 0)
  }
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE agent_id=${claimed.agent_id}::uuid AND event_id=${eventId}::uuid`
      )[0]?.n,
    ),
    1,
  )
  const revoker = new PostgresConnectorRevocation(revokeSql)
  assert.equal(
    (
      await revoker.revoke({
        ...subject,
        agentId: claimed.agent_id,
        expectedFingerprint: agent.fingerprint,
      })
    ).ok,
    true,
  )
  let deniedEventId: string
  if (built) {
    deniedEventId = await built.runClient(clientFixture, 'revoked')
  } else {
    if (!queue || !sender) throw new Error('Missing local fixture')
    deniedEventId = queue.enqueue(
      {
        printerKey: 'simulator',
        state: 'idle',
        progress: 0,
        observedAt: Date.now(),
      },
      Date.now(),
    ).eventId
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(
      (
        await drainTelemetryOnce(
          queue,
          sender,
          Date.now,
          new AbortController().signal,
        )
      ).status,
      'retained',
    )
    assert.equal(queue.depth, 1)
  }
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.telemetry_events WHERE agent_id=${claimed.agent_id}::uuid AND event_id=${deniedEventId}::uuid`
      )[0]?.n,
    ),
    0,
  )
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: [
        'dedicated role and inherited, NOINHERIT, database/schema/table ownership denials',
        'actual proof and Node HTTP',
        'lost acknowledgement and durable deduplication',
        'enrollment revocation denies retry',
      ],
      builtNuxt: builtMode,
    }),
  )
} finally {
  const failures: string[] = []
  async function cleanup(label: string, action: () => Promise<void> | void) {
    try {
      await action()
    } catch {
      failures.push(label)
    }
  }
  await cleanup('queue', () => queue?.close())
  await cleanup('built application and proxy', async () => {
    await built?.close()
  })
  await cleanup('local HTTP server', async () => {
    if (!server?.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) =>
      server?.close((error) => (error ? reject(error) : resolveClose())),
    )
  })
  for (const pool of pools)
    await cleanup('SQL pool', () => pool.end({ timeout: 3 }))
  for (const role of created.reverse())
    await cleanup('synthetic database role', async () => {
      await admin`DROP ROLE ${admin(role)}`
    })
  await cleanup('administrative pool', () => admin.end({ timeout: 3 }))
  const ownedDirectory = directory
  if (ownedDirectory)
    await cleanup('fixture directory', () =>
      rm(ownedDirectory, { recursive: true, force: true }),
    )
  await appendFile(
    ledgerPath,
    JSON.stringify({
      cleanup: failures.length
        ? 'incomplete'
        : 'fixture-owned roles, pools, servers and directory removed',
      failures,
    }) + '\n',
    { mode: 0o600 },
  )
  if (failures.length) throw new Error('Synthetic fixture cleanup incomplete')
}
