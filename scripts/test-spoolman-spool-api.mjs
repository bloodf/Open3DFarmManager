// Evidence for Spoolman v0.27.1 spool API parity (#540) on the farm-scoped
// legacy HTTP path.
//
// Replays the recorded upstream answers in
// tests/fixtures/spoolman/spool-api/upstream.json (captured from the pinned
// image by scripts/capture-spoolman-spool-api.mjs) and literal upstream client
// contracts (Moonraker, OctoPrint, Home Assistant, OrcaSlicer, Connector,
// Kobra X) over a loopback HTTP server wired to the legacy handler, then checks
// cross-farm isolation, read-only and invalid/revoked credentials, unclaimed
// sibling paths, and zero secret leakage in PostgreSQL or app logs.
//
// PostgreSQL runs only in one task-owned Docker container (digest-pinned local
// postgres:17 image, never pulled, loopback port, removed on exit). Nothing
// touches printers, host services or another task's resources.
//
//   node scripts/test-spoolman-spool-api.mjs
//
// Optional: SPOOL_API_EVIDENCE_DIR (ledger + diagnostics, outside the repo),
// SPOOL_LIBRARY_TEST_IMAGE (a postgres:17@sha256:... present locally).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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
import {
  LEGACY_API_MODULES,
  handleLegacyRequest,
} from '../apps/farm/server/utils/spool-library/legacy-handler.ts'
import { classifyLegacyBody } from '../apps/farm/server/utils/spool-library/legacy-api/body.ts'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
} from './db/migrations.ts'

const exec = promisify(execFile)
const MIGRATION = '0088_spoolman_spool_api'
const TASK_LABEL = 'spoolman-spool-api-540'
const PINNED_SPOOLMAN_IMAGE_ID =
  'sha256:1ebb4f6a62c2e72a07f18b07ebfdbd96322f5bc2eb72570af3088f68d7c393b1'
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spoolman-spool-api.mjs',
  )

const checks = []
const check = (name) => checks.push(name)
const readText = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const read = (path) => JSON.parse(readText(path))
const spec = read('../docs/compatibility/spoolman-openapi-v0.27.1.json')
const upstreamLock = read(
  '../third_party/spoolman-reference/upstream.lock.json',
)
const recorded = read('../tests/fixtures/spoolman/spool-api/upstream.json')
const casesText = readText('../tests/fixtures/spoolman/spool-api/cases.json')
const cases = JSON.parse(casesText)
const casesSha256 = createHash('sha256').update(casesText).digest('hex')
const clientContracts = read(
  '../tests/fixtures/spoolman/upstream-contract/requests.json',
)

// ---- static contract: fixture provenance, pinned OpenAPI surface & HTTP route wiring
assert.equal(recorded.upstream, 'Spoolman v0.27.1')
assert.equal(recorded.image, PINNED_SPOOLMAN_IMAGE_ID)
assert.equal(recorded.sourceRevision, upstreamLock.upstream.source_revision)
assert.equal(recorded.casesSha256, casesSha256)
assert.equal(
  typeof recorded.capturedAt === 'string' &&
    !Number.isNaN(Date.parse(recorded.capturedAt)),
  true,
  'upstream.json must record a valid capturedAt timestamp',
)
assert.deepEqual(
  recorded.cases.map(({ name, method, path }) => ({ name, method, path })),
  cases.map(({ name, method, path }) => ({ name, method, path })),
  'upstream.json must be re-captured after editing cases.json',
)

const methods = (path) => Object.keys(spec.paths[path] ?? {}).sort()
assert.deepEqual(methods('/spool'), ['get', 'post'])
assert.deepEqual(methods('/spool/{spool_id}'), ['delete', 'get', 'patch'])
assert.deepEqual(methods('/spool/{spool_id}/use'), ['put'])
assert.deepEqual(methods('/spool/{spool_id}/measure'), ['put'])
const spoolQuery = spec.paths['/spool'].get.parameters.map((p) => p.name)
for (const name of [
  'filament_name',
  'filament_id',
  'filament_material',
  'vendor_name',
  'vendor_id',
  'filament.name',
  'filament.id',
  'filament.material',
  'filament.multi_color_direction',
  'filament.vendor.name',
  'filament.vendor.id',
  'location',
  'lot_nr',
  'tag',
  'allow_archived',
  'first_used',
  'last_used',
  'registered',
  'sort',
  'limit',
  'offset',
])
  assert.ok(spoolQuery.includes(name), `spool query ${name}`)
const schemaKeys = (name) =>
  Object.keys(spec.components.schemas[name].properties)
check('openapi-spool-paths-and-query-parameters-pinned')

const routeSource = readText('../apps/farm/server/routes/spoolman/[...path].ts')
assert.ok(routeSource.includes('handleLegacyRequest'))
assert.ok(routeSource.includes('classifyLegacyBody'))
assert.ok(routeSource.includes("['POST', 'PATCH', 'PUT']"))
assert.ok(routeSource.includes("'Cache-Control', 'no-store'"))
assert.ok(routeSource.includes("'Referrer-Policy', 'no-referrer'"))
assert.ok(LEGACY_API_MODULES.some((m) => m.name === 'spool'))
check('legacy-http-route-and-spool-module-wired')

// ---- disposable PostgreSQL
const evidenceDir = resolve(
  process.env.SPOOL_API_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spool-api-'))),
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
      timeout: 600_000,
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
  'A digest-pinned postgres:17 image must exist locally',
)

process.env.OPENFARM_PG = 'docker'
const containerName = `o3dfm-spool-api-540-${randomBytes(4).toString('hex')}`
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
let runtime
let server
const secrets = []
const appOutput = []

try {
  const admin = await fixture.start()
  ledger({
    resource: 'container',
    name: containerName,
    image,
    port: fixture.port,
  })
  const migrationCatalog = catalogThrough(
    await loadMigrationCatalog(),
    MIGRATION,
  )
  await runMigrations(admin, migrationCatalog, {
    kind: 'down',
    expectedLastId: MIGRATION,
  })
  await runMigrations(admin, migrationCatalog, { kind: 'up' })
  check('migration-0088-down-up-round-trip')

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
  check('migration-0088-role-policy-still-valid')

  let clock = Date.UTC(2026, 10, 21, 8, 0, 0)
  const farms = [randomUUID(), randomUUID(), randomUUID()]
  for (let i = 0; i < farms.length; i++) {
    await admin`INSERT INTO farm.farms (id) VALUES (${farms[i]}::uuid)`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${`acc-${i}`})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${`session-${i}`}, ${`acc-${i}`}, 0, ${clock}, ${clock}, ${clock + 86_400_000})`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farms[i]}::uuid, ${`acc-${i}`}, 'owner')`
  }
  const store = new PostgresSpoolLibrary(runtime, () => clock)
  const must = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const manage = (i) => ({
    sessionRecordId: `session-${i}`,
    policy: { idleTimeoutMs: 1e12 },
    farmId: farms[i],
  })
  const credentialIds = new Map()
  const issue = async (i, access) => {
    const { token, credential } = must(
      await store.issueLegacyCredential({
        ...manage(i),
        label: `${access}-${i}`,
        access,
      }),
    )
    secrets.push(token, token.split('.')[2])
    credentialIds.set(token, credential.id)
    return token
  }
  const writeA = await issue(0, 'write')
  const readA = await issue(0, 'read')
  const writeB = await issue(1, 'write')
  const writeC = await issue(2, 'write')

  // Loopback HTTP server mirroring apps/farm/server/routes/spoolman/[...path].ts
  server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const url = req.url ?? '/'
    const queryAt = url.indexOf('?')
    const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
    const query = new URLSearchParams(
      queryAt === -1 ? '' : url.slice(queryAt + 1),
    )
    let raw
    if (['POST', 'PATCH', 'PUT'].includes(req.method ?? '')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
    }
    const writeStderr = process.stderr.write
    process.stderr.write = (line) => appOutput.push(String(line)) > 0
    let result
    try {
      result = await handleLegacyRequest(store, {
        method: req.method ?? 'GET',
        pathname,
        query,
        body: classifyLegacyBody(raw, req.headers['content-type']),
      })
    } finally {
      process.stderr.write = writeStderr
    }
    res.statusCode = result.status
    res.setHeader('Content-Type', 'application/json')
    for (const [k, v] of Object.entries(result.headers ?? {}))
      res.setHeader(k, v)
    res.end(
      typeof result.body === 'string'
        ? result.body
        : JSON.stringify(result.body),
    )
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  const call = async (token, method, path, body, contentType) => {
    const headers = {}
    if (body !== undefined)
      headers['Content-Type'] = contentType ?? 'application/json'
    const response = await fetch(`${baseUrl}/spoolman/${token}${path}`, {
      method,
      headers,
      body,
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    const text = await response.text()
    let parsed = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    return {
      status: response.status,
      body: parsed,
      headers: Object.fromEntries(response.headers.entries()),
    }
  }
  const json = (value) =>
    value === undefined || value === null ? undefined : JSON.stringify(value)
  const ISO_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/
  // Normalize server-clock timestamps (`registered`, and `first_used`/`last_used`
  // stamped >= 2025 by `use`/`measure`), while keeping explicit 2024 dates exact.
  const normalize = (value, normalizeAllDates = false) => {
    if (Array.isArray(value))
      return value.map((v) => normalize(v, normalizeAllDates))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (k === 'registered') {
            assert.match(v, ISO_Z)
            return [k, '<timestamp>']
          }
          if (
            (k === 'first_used' || k === 'last_used') &&
            typeof v === 'string'
          ) {
            assert.match(v, ISO_Z)
            if (normalizeAllDates || v >= '2025-01-01T00:00:00Z')
              return [k, '<timestamp>']
          }
          return [k, normalize(v, normalizeAllDates)]
        }),
      )
    return value
  }
  const keyOrder = (value, parentKey = null) =>
    parentKey === 'extra'
      ? null
      : Array.isArray(value)
        ? value.map((item) => keyOrder(item))
        : value && typeof value === 'object'
          ? Object.entries(value).map(([k, v]) => [k, keyOrder(v, k)])
          : null

  // ---- replay every recorded upstream v0.27.1 answer on farm A over HTTP
  let replayed = 0
  for (const item of recorded.cases) {
    clock += 1000
    if (item.setup === 'field') {
      assert.equal(item.status, 200, `${item.name}: upstream setup`)
      const [, , , , entity, key] = item.path.split('/')
      const b = item.body
      await admin`INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, sort_order, unit, default_value, choices, multi_choice, source_key, source_sha256, updated_at)
        VALUES (${farms[0]}::uuid, ${entity}, ${key}, ${b.name}, ${b.field_type}, ${b.order ?? 0}, ${b.unit ?? null}, ${b.default_value ?? null}, ${b.choices ? admin.json(b.choices) : null}, ${b.multi_choice ?? false}, 'contract-540', ${createHash('sha256').update(key).digest('hex')}, 1)`
      continue
    }
    const raw = item.rawBody ?? json(item.body)
    const actual = await call(
      writeA,
      item.method,
      item.path,
      raw,
      item.contentType,
    )
    assert.equal(
      actual.status,
      item.status,
      `${item.name}: status ${JSON.stringify(actual.body)}`,
    )
    const total = actual.headers['x-total-count'] ?? null
    assert.equal(total, item.total, `${item.name}: x-total-count`)
    if (item.compare === 'status-type') {
      assert.equal(
        actual.body.detail[0].type,
        item.response.detail[0].type,
        `${item.name}: error type`,
      )
    } else {
      assert.deepEqual(
        normalize(actual.body),
        normalize(item.response),
        `${item.name}: body`,
      )
      assert.deepEqual(
        keyOrder(actual.body),
        keyOrder(item.response),
        `${item.name}: key order`,
      )
    }
    replayed++
  }
  assert.ok(replayed >= 100, `replayed ${replayed} upstream answers`)
  check(`upstream-v0.27.1-spool-fixtures-replayed-${replayed}`)

  const spoolsA = (
    await call(writeA, 'GET', '/api/v1/spool?allow_archived=true&sort=id:asc')
  ).body
  assert.ok(spoolsA.length > 0)
  for (const record of spoolsA)
    for (const key of Object.keys(record))
      assert.ok(schemaKeys('Spool').includes(key), `Spool.${key}`)
  check('spool-responses-use-only-openapi-schema-fields')

  // ---- literal upstream client contracts (Moonraker, OctoPrint, Home Assistant, OrcaSlicer) on farm C
  let clientReplayed = 0
  for (const step of clientContracts) {
    if (step.path === '/api/v1/location') continue
    clock += 1000
    const raw =
      step.body === null || step.body === undefined
        ? undefined
        : JSON.stringify(step.body)
    const actual = await call(writeC, step.method, step.path, raw)
    assert.equal(
      actual.status,
      step.status,
      `${step.name} (${step.client}): status`,
    )
    assert.deepEqual(
      normalize(actual.body, true),
      step.response,
      `${step.name} (${step.client}): response`,
    )
    clientReplayed++
  }
  assert.equal(clientReplayed, 9)
  // Connector inventory/probe + Kobra X use_weight contract
  const connectorProbe = await call(
    writeC,
    'GET',
    '/api/v1/spool?limit=2&offset=0&sort=id:asc&allow_archived=true',
  )
  assert.equal(connectorProbe.status, 200)
  assert.equal(connectorProbe.headers['x-total-count'], '1')
  assert.equal(connectorProbe.body.length, 1)
  const kobraUse = await call(
    writeC,
    'PUT',
    '/api/v1/spool/1/use',
    JSON.stringify({ use_weight: 12.5 }),
  )
  assert.equal(kobraUse.status, 200)
  assert.ok(
    Math.abs(kobraUse.body.used_weight - (0.298254952550181 + 12.5)) < 1e-9,
  )
  check(
    'literal-upstream-client-contracts-moonraker-octoprint-ha-orca-connector-kobra',
  )

  // Unclaimed sibling subpath `/api/v1/spool/group` stays 404
  const groupUnclaimed = await call(
    writeA,
    'GET',
    '/api/v1/spool/group?group_by=location',
  )
  assert.deepEqual(
    [groupUnclaimed.status, groupUnclaimed.body],
    [404, { message: 'Not Found' }],
  )
  check('sibling-spool-group-path-left-unclaimed')

  // ---- cross-farm isolation: farm B sees nothing of farm A and cannot touch it
  const emptyB = await call(writeB, 'GET', '/api/v1/spool?allow_archived=true')
  assert.deepEqual(
    [emptyB.status, emptyB.body, emptyB.headers['x-total-count']],
    [200, [], '0'],
  )
  const spoolIdA = spoolsA[0].id
  assert.deepEqual(
    [
      (await call(writeB, 'GET', `/api/v1/spool/${spoolIdA}`)).status,
      (
        await call(
          writeB,
          'PATCH',
          `/api/v1/spool/${spoolIdA}`,
          JSON.stringify({ location: 'stolen' }),
        )
      ).status,
      (await call(writeB, 'DELETE', `/api/v1/spool/${spoolIdA}`)).status,
      (
        await call(
          writeB,
          'PUT',
          `/api/v1/spool/${spoolIdA}/use`,
          JSON.stringify({ use_weight: 5 }),
        )
      ).status,
      (
        await call(
          writeB,
          'PUT',
          `/api/v1/spool/${spoolIdA}/use`,
          JSON.stringify({ use_length: 100 }),
        )
      ).status,
    ],
    [404, 404, 404, 404, 404],
  )
  const crossMeasure = await call(
    writeB,
    'PUT',
    `/api/v1/spool/${spoolIdA}/measure`,
    JSON.stringify({ weight: 500 }),
  )
  assert.deepEqual(
    [crossMeasure.status, crossMeasure.body],
    [400, { message: 'Spool not found.' }],
  )
  const crossCreate = await call(
    writeB,
    'POST',
    '/api/v1/spool',
    JSON.stringify({ filament_id: spoolsA[0].filament.id }),
  )
  assert.deepEqual(
    [crossCreate.status, crossCreate.body],
    [404, { message: `No filament with ID ${spoolsA[0].filament.id} found.` }],
  )
  // Farm B creates its own filament + spool (independent id=1), uses, measures, deletes
  const filB = await call(
    writeB,
    'POST',
    '/api/v1/filament',
    JSON.stringify({
      name: 'Farm B PLA',
      material: 'PLA',
      density: 1.24,
      diameter: 1.75,
      weight: 1000,
      spool_weight: 150,
    }),
  )
  assert.equal(filB.status, 200)
  assert.equal(filB.body.id, 1)
  const spoolB = await call(
    writeB,
    'POST',
    '/api/v1/spool',
    JSON.stringify({ filament_id: 1, location: 'Farm B Shelf' }),
  )
  assert.equal(spoolB.status, 200)
  assert.equal(spoolB.body.id, 1)
  assert.equal(
    (
      await call(
        writeB,
        'PUT',
        '/api/v1/spool/1/use',
        JSON.stringify({ use_weight: 50 }),
      )
    ).body.used_weight,
    50,
  )
  assert.equal(
    (
      await call(
        writeB,
        'PUT',
        '/api/v1/spool/1/measure',
        JSON.stringify({ weight: 900 }),
      )
    ).body.remaining_weight,
    750,
  )
  assert.equal((await call(writeB, 'DELETE', '/api/v1/spool/1')).status, 200)
  const afterA = (
    await call(writeA, 'GET', '/api/v1/spool?allow_archived=true&sort=id:asc')
  ).body
  assert.deepEqual(afterA, spoolsA, 'farm A spools unchanged by farm B traffic')
  check('cross-farm-isolation-for-all-7-spool-endpoints')

  // ---- read-only credential: reads succeed, all mutations refused 403 before validation
  assert.equal((await call(readA, 'GET', '/api/v1/spool')).status, 200)
  assert.equal(
    (await call(readA, 'GET', `/api/v1/spool/${spoolIdA}`)).status,
    200,
  )
  for (const [method, path, body] of [
    ['POST', '/api/v1/spool', JSON.stringify({ filament_id: 1 })],
    ['POST', '/api/v1/spool', '{'],
    ['PATCH', `/api/v1/spool/${spoolIdA}`, JSON.stringify({ location: 'x' })],
    ['DELETE', `/api/v1/spool/${spoolIdA}`],
    ['PUT', `/api/v1/spool/${spoolIdA}/use`, JSON.stringify({ use_weight: 1 })],
    [
      'PUT',
      `/api/v1/spool/${spoolIdA}/measure`,
      JSON.stringify({ weight: 500 }),
    ],
  ]) {
    const denied = await call(readA, method, path, body)
    assert.deepEqual(
      [denied.status, denied.body],
      [403, { message: 'Forbidden' }],
      `${method} ${path}`,
    )
  }
  check('read-credential-cannot-mutate-spools')

  // ---- invalid, forged, and revoked credentials rejected with 401
  const forged = `sl1.${writeA.split('.')[1]}.${writeB.split('.')[2]}`
  for (const token of ['invalid', forged, writeA + 'x', ''])
    for (const [method, path] of [
      ['GET', '/api/v1/spool'],
      ['POST', '/api/v1/spool'],
      ['PUT', '/api/v1/spool/1/use'],
      ['PUT', '/api/v1/spool/1/measure'],
    ]) {
      const rejected = await call(
        token,
        method,
        path,
        method === 'GET' ? undefined : JSON.stringify({ filament_id: 1 }),
      )
      assert.deepEqual(
        [rejected.status, rejected.body],
        [401, { message: 'Unauthorized' }],
      )
    }
  must(
    await store.revokeLegacyCredential({
      ...manage(1),
      credentialId: credentialIds.get(writeB),
    }),
  )
  assert.equal((await call(writeB, 'GET', '/api/v1/spool')).status, 401)
  assert.equal((await call(writeA, 'GET', '/api/v1/spool')).status, 200)
  check('invalid-forged-and-revoked-credentials-rejected')

  // ---- zero credential secrets in PostgreSQL logs or app output
  const fullLog = await exec('docker', ['logs', containerName], {
    maxBuffer: 64 * 1024 * 1024,
  }).then((r) => r.stdout + r.stderr)
  assert.ok(fullLog.includes('farm.spools'), 'statement logging must be active')
  for (const secret of secrets) {
    assert.equal(
      fullLog.includes(secret),
      false,
      'credential reached database logs',
    )
    assert.equal(
      appOutput.join('').includes(secret),
      false,
      'credential reached application output',
    )
    assert.equal(JSON.stringify(checks).includes(secret), false)
  }
  check('no-credential-secret-in-logs')

  console.log(
    JSON.stringify(
      { ok: true, container: containerName, image, evidenceDir, checks },
      null,
      2,
    ),
  )
} catch (error) {
  process.exitCode = 1
  const text = redact(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )
  await writeFile(
    join(evidenceDir, 'failure.json'),
    JSON.stringify({ error: text.slice(0, 32768), checks }, null, 2),
    { mode: 0o600 },
  ).catch(() => {})
  console.error(`FAILED after ${checks.length} checks: ${text.slice(0, 4000)}`)
  console.error(`Diagnostics retained in ${evidenceDir}`)
} finally {
  await new Promise((done) => (server ? server.close(done) : done()))
  await runtime?.end({ timeout: 3 }).catch(() => {})
  try {
    await fixture.stop()
  } catch (error) {
    console.error(
      `Container removal reported: ${redact(String(error)).split('\n', 1)[0]}`,
    )
  }
  let leftover = ''
  for (let attempt = 0; attempt < 45; attempt++) {
    leftover = await docker(
      'ps',
      '-aq',
      '--filter',
      `name=^/${containerName}$`,
    ).catch(() => 'unknown')
    if (leftover === '') break
    if (/^[a-f0-9]+$/.test(leftover))
      await docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "o3dfm.task"}}',
        leftover,
      )
        .then((label) =>
          label === TASK_LABEL ? docker('rm', '-f', '-v', leftover) : undefined,
        )
        .catch(() => {})
    await new Promise((done) => setTimeout(done, 2000))
  }
  ledger({
    cleanup: 'container',
    name: containerName,
    remaining: leftover === '' ? 'none' : leftover,
  })
  if (leftover !== '') {
    process.exitCode = 1
    console.error(
      `Cleanup incomplete: container ${containerName} still present`,
    )
  } else
    console.log(
      `Cleanup: container ${containerName} removed; ledger ${ledgerPath}`,
    )
}

function redact(text) {
  let out = String(text)
    .replace(/(\/spoolman\/)[^/\s?#]+/g, '$1<redacted>')
    .replace(/sl1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}/g, 'sl1.<redacted>')
  for (const secret of secrets) out = out.replaceAll(secret, '<redacted>')
  return out
}
