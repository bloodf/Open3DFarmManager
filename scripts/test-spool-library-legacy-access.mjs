// Evidence for farm-scoped legacy Spoolman client access.
//
// PostgreSQL runs only in one task-owned Docker container (digest-pinned local
// postgres:17 image, never pulled, loopback port, read-only root, removed on
// exit). The handler is called in-process. Nothing listens on the host, and
// nothing touches printers, host services or another task's resources.
//
//   node scripts/test-spool-library-legacy-access.mjs
//
// Optional: SPOOL_LEGACY_EVIDENCE_DIR (ledger + diagnostics, outside the repo),
// SPOOL_LIBRARY_TEST_IMAGE (a postgres:17@sha256:... reference present locally).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
} from '../tests/helpers/disposable-postgres.ts'
import { PostgresSpoolLibrary } from '../apps/farm/server/storage/postgres-spool-library.ts'
import { validateSpoolLibraryRole } from '../apps/farm/server/utils/spool-library/role-policy.ts'
import { handleLegacyRequest } from '../apps/farm/server/utils/spool-library/legacy-handler.ts'
import { sanitizeUnhandledErrorPath } from '../apps/farm/server/utils/spool-library/legacy-path.ts'

const exec = promisify(execFile)
const MIGRATION = '0085_spool_library_storage'
const TASK_LABEL = 'farm-legacy-541'
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spool-library-legacy-access.mjs',
  )

assert.equal(commandStderr({ stderr: 'docker: denied\n' }), 'docker: denied\n')
assert.equal(
  commandStderr({ stderr: Buffer.from('docker: no such image\n') }),
  'docker: no such image\n',
)
assert.equal(commandStderr(new Error('x')), '')

const spec = JSON.parse(
  readFileSync(
    new URL(
      '../docs/compatibility/spoolman-openapi-v0.27.1.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const healthSchema = spec.components.schemas.HealthCheck
const messageSchema = spec.components.schemas.Message
assert.equal(
  spec.paths['/health'].get.responses['200'].content['application/json'].schema
    .$ref,
  '#/components/schemas/HealthCheck',
)
assert.deepEqual(healthSchema.required, ['status'])
assert.equal(healthSchema.properties.status.type, 'string')
const healthy = healthSchema.properties.status.examples[0]
assert.equal(healthy, 'healthy')
assert.deepEqual(messageSchema.required, ['message'])
assert.equal(messageSchema.properties.message.type, 'string')
assert.equal(
  spec.info.description.includes('`/api/v1/`'),
  true,
  'health is served under /api/v1',
)

const pathCredential = 'sl1.0123456789abcdef0123456789abcdef.' + 'a'.repeat(43)
assert.equal(
  sanitizeUnhandledErrorPath(
    `/spoolman/${pathCredential}/api/v1/health?secret=query`,
  ),
  '/spoolman/<redacted>/api/v1/health',
)
assert.equal(
  sanitizeUnhandledErrorPath('/api/v1/health?secret=query'),
  '/api/v1/health',
)
const routeSource = readFileSync(
  new URL('../apps/farm/server/routes/spoolman/[...path].ts', import.meta.url),
  'utf8',
)
assert.match(routeSource, /handleLegacyRequest\(await spoolLibraryRuntime\(\)/)
const errorSource = readFileSync(
  new URL('../apps/farm/server/utils/log-unhandled-error.ts', import.meta.url),
  'utf8',
)
assert.match(errorSource, /sanitizeUnhandledErrorPath\(event\?\.path\)/)

const evidenceDir = resolve(
  process.env.SPOOL_LEGACY_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spool-legacy-'))),
)
const inside = relative(repoRoot, evidenceDir)
if (inside === '' || (!inside.startsWith('..') && !inside.startsWith('/')))
  throw new Error('Evidence directory must be outside the repository')
await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
const ledgerPath = join(evidenceDir, 'ledger.jsonl')
const ledger = (entry) =>
  appendFileSync(
    ledgerPath,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  )

const docker = async (...args) =>
  (
    await exec('docker', args, {
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim()
const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
const image =
  process.env.SPOOL_LIBRARY_TEST_IMAGE ??
  (
    await docker(
      'image',
      'inspect',
      'postgres:17',
      '--format',
      '{{index .RepoDigests 0}}',
    )
  ).replace(/^postgres@/, 'postgres:17@')
assert.match(
  image,
  POSTGRES_IMAGE_PATTERN,
  'A digest-pinned postgres:17 image must already exist locally',
)

process.env.OPENFARM_PG = 'docker'
const containerName = `o3dfm-spool-legacy-541-${randomBytes(4).toString('hex')}`
const fixture = disposablePostgres({
  name: containerName,
  labelKey: 'o3dfm.task',
  labelValue: TASK_LABEL,
  docker,
  image,
  ledger,
  through: MIGRATION,
  postgresArgs: ['-c', 'log_statement=all', '-c', 'log_min_messages=info'],
})

const checks = []
const check = (name) => checks.push(name)
let runtime
const secrets = []

try {
  const admin = await fixture.start()
  ledger({
    resource: 'container',
    name: containerName,
    image,
    port: fixture.port,
  })
  const role = 'spool_library_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library`
  runtime = postgres({
    host: '127.0.0.1',
    port: fixture.port,
    database: 'fixture',
    username: role,
    password: '',
    ssl: false,
    max: 4,
    connect_timeout: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
  await validateSpoolLibraryRole(runtime)
  const farms = [randomUUID(), randomUUID()]
  for (let i = 0; i < 2; i++) {
    await admin`INSERT INTO farm.farms (id) VALUES (${farms[i]}::uuid)`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${`acc-${i}`})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${`session-${i}`}, ${`acc-${i}`}, 0, 100, 100, 10000000)`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farms[i]}::uuid, ${`acc-${i}`}, 'owner')`
  }
  const store = new PostgresSpoolLibrary(runtime, () => 500)
  const must = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const manage = (i) => ({
    sessionRecordId: `session-${i}`,
    policy: { idleTimeoutMs: 1000000 },
    farmId: farms[i],
  })
  const issued = []
  for (let i = 0; i < 2; i++) {
    issued.push(
      must(
        await store.issueLegacyCredential({
          ...manage(i),
          label: `client-${i}`,
          access: 'read',
        }),
      ),
    )
    secrets.push(issued[i].token, issued[i].token.split('.')[2])
    must(
      await store.withScope({ kind: 'session', ...manage(i) }, (r) =>
        r.vendors.create({ name: `farm-${i}` }),
      ),
    )
  }
  const request = (
    token,
    path = '/api/v1/health',
    method = 'GET',
    dispatch,
  ) => {
    const pathname = `/spoolman/${token}${path}`
    const incoming = new Request(new URL(pathname, 'http://127.0.0.1'), {
      method,
    })
    assert.equal(incoming.headers.has('authorization'), false)
    return handleLegacyRequest(store, { request: incoming, pathname }, dispatch)
  }
  const assertMessage = (body) => {
    assert.deepEqual(Object.keys(body), messageSchema.required)
    assert.equal(typeof body.message, 'string')
    assert.equal(body.message.length > 0, true)
  }
  for (const credential of issued) {
    const response = await request(credential.token)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { status: healthy })
    assert.deepEqual(Object.keys(response.body), healthSchema.required)
  }
  check('health-without-authorization-matches-openapi')

  // Test-only dispatch. Not a Spoolman wire payload: it proves another path
  // sees the same farm-scoped repository.
  const scoped = async (repo, method, path) => {
    if (method === 'GET' && path === '/api/v1/vendor')
      return repo.vendors.list({ limit: 10 })
    if (method === 'POST' && path === '/api/v1/vendor')
      return repo.vendors.create({ name: 'smuggled' })
    if (method === 'GET' && path === '/api/v1/farm')
      return { ok: true, value: { farmId: repo.farmId } }
    return { ok: false, reason: 'not-found' }
  }
  for (let i = 0; i < 2; i++) {
    const vendors = await request(
      issued[i].token,
      '/api/v1/vendor',
      'GET',
      scoped,
    )
    assert.equal(vendors.status, 200)
    assert.deepEqual(
      vendors.body.map((vendor) => vendor.name),
      [`farm-${i}`],
    )
    const farm = await request(issued[i].token, '/api/v1/farm', 'GET', scoped)
    assert.deepEqual(farm.body, { farmId: farms[i] })
  }
  const denied = await request(
    issued[0].token,
    '/api/v1/vendor',
    'POST',
    scoped,
  )
  assert.equal(denied.status, 403)
  assertMessage(denied.body)
  const still = await request(issued[0].token, '/api/v1/vendor', 'GET', scoped)
  assert.deepEqual(
    still.body.map((vendor) => vendor.name),
    ['farm-0'],
  )
  check('farm-isolation-and-read-token-cannot-write')

  const forged = `sl1.${issued[0].token.split('.')[1]}.${issued[1].token.split('.')[2]}`
  for (const token of ['invalid', forged, issued[0].token + 'x']) {
    const rejected = await request(token)
    assert.equal(rejected.status, 401)
    assertMessage(rejected.body)
  }
  const escaped = await request(issued[0].token, '/../api/v1/health')
  assert.equal(escaped.status, 401)
  assertMessage(escaped.body)
  const missing = await request(issued[0].token, '/api/v1/spool')
  assert.equal(missing.status, 404)
  assertMessage(missing.body)
  const posted = await request(issued[0].token, '/api/v1/health', 'POST')
  assert.equal(posted.status, 404)
  assertMessage(posted.body)
  check('malformed-and-out-of-scope-paths-rejected')

  must(
    await store.revokeLegacyCredential({
      ...manage(0),
      credentialId: issued[0].credential.id,
    }),
  )
  assert.equal((await request(issued[0].token)).status, 401)
  assert.equal((await request(issued[1].token)).status, 200)
  check('revoked-token-rejected-sibling-farm-still-works')

  const fullLog = await exec('docker', ['logs', containerName], {
    maxBuffer: 64 * 1024 * 1024,
  }).then((r) => r.stdout + r.stderr)
  assert.ok(
    fullLog.includes('spool_library_credentials'),
    'statement logging must be active',
  )
  for (const secret of secrets) {
    assert.equal(fullLog.includes(secret), false, 'credential reached logs')
    assert.equal(JSON.stringify(checks).includes(secret), false)
  }
  check('no-credential-secret-in-results-or-server-logs')
  console.log(
    JSON.stringify(
      { ok: true, container: containerName, image, evidenceDir, checks },
      null,
      2,
    ),
  )
} catch (error) {
  process.exitCode = 1
  const diagnostics = {
    error: redact(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
    stderr: redact(commandStderr(error)).slice(0, 16384),
    stdout: redact(commandText(error?.stdout)).slice(0, 16384),
    signal: error?.signal ?? null,
    killed: error?.killed === true,
    exitCode: error?.code ?? null,
    checksPassed: checks,
    container: containerName,
    image,
  }
  await writeFile(
    join(evidenceDir, 'failure.json'),
    JSON.stringify(diagnostics, null, 2),
    { mode: 0o600 },
  ).catch(() => {})
  await docker('logs', '--tail', '400', containerName)
    .then((logs) =>
      writeFile(join(evidenceDir, 'postgres-container.log'), redact(logs), {
        mode: 0o600,
      }),
    )
    .catch(() => {})
  console.error(
    `FAILED after ${checks.length} checks: ${redact(error instanceof Error ? error.message : String(error))}`,
  )
  console.error(`Diagnostics retained in ${evidenceDir}`)
} finally {
  await runtime?.end({ timeout: 3 }).catch(() => {})
  let cleanupFailed = false
  try {
    await fixture.stop()
  } catch (error) {
    console.error(
      `Container removal reported: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
    )
  }
  let leftover = ''
  for (let attempt = 0; attempt < 45; attempt++) {
    leftover = await docker(
      'ps',
      '-aq',
      '--filter',
      `name=^/${containerName}$`,
    ).catch((e) => `unknown: ${e}`)
    if (leftover === '') break
    if (/^[a-f0-9]+$/.test(leftover))
      await docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "o3dfm.task"}}',
        leftover,
      )
        .then((label) =>
          label === TASK_LABEL ? docker('rm', '-f', leftover) : undefined,
        )
        .catch(() => {})
    await new Promise((done) => setTimeout(done, 2000))
  }
  cleanupFailed = leftover !== ''
  ledger({
    cleanup: 'container',
    name: containerName,
    remaining: leftover === '' ? 'none' : leftover,
  })
  if (cleanupFailed) {
    process.exitCode = 1
    console.error(
      `Cleanup incomplete: container ${containerName} still present`,
    )
  } else
    console.log(
      `Cleanup: container ${containerName} removed; ledger ${ledgerPath}`,
    )
}

function commandText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

function commandStderr(error) {
  const raw =
    error && typeof error === 'object' && 'stderr' in error ? error.stderr : ''
  return commandText(raw)
}

function redact(text) {
  let out = text.replace(
    /sl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}/g,
    'sl1.<redacted>',
  )
  for (const secret of secrets) out = out.replaceAll(secret, '<redacted>')
  return out
}
