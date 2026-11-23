// Evidence for Spoolman v0.27.1 vendor and filament API parity (#547) on the
// farm-scoped legacy path.
//
// Replays the recorded upstream answers in
// tests/fixtures/spoolman/vendor-filament/upstream.json (captured from the
// pinned image by scripts/capture-spoolman-vendor-filament.mjs) against the
// in-process handler, then checks cross-farm isolation, read-only and invalid
// credentials, the module interface and that no credential reaches a log.
//
// PostgreSQL runs only in one task-owned Docker container (digest-pinned local
// postgres:17 image, never pulled, loopback port, removed on exit). Nothing
// touches printers, host services or another task's resources.
//
//   node scripts/test-spoolman-vendor-filament.mjs
//
// Optional: SPOOL_VENDOR_FILAMENT_EVIDENCE_DIR (ledger + diagnostics, outside
// the repo), SPOOL_LIBRARY_TEST_IMAGE (a postgres:17@sha256:... present locally).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
const MIGRATION = '0087_spoolman_vendor_filament'
const TASK_LABEL = 'spoolman-vendor-filament-547'
const PINNED_SPOOLMAN_IMAGE_ID =
  'sha256:1ebb4f6a62c2e72a07f18b07ebfdbd96322f5bc2eb72570af3088f68d7c393b1'
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spoolman-vendor-filament.mjs',
  )

const checks = []
const check = (name) => checks.push(name)
const readText = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const read = (path) => JSON.parse(readText(path))
const spec = read('../docs/compatibility/spoolman-openapi-v0.27.1.json')
const upstreamLock = read(
  '../third_party/spoolman-reference/upstream.lock.json',
)
const recorded = read(
  '../tests/fixtures/spoolman/vendor-filament/upstream.json',
)
const casesText = readText(
  '../tests/fixtures/spoolman/vendor-filament/cases.json',
)
const cases = JSON.parse(casesText)
const casesSha256 = createHash('sha256').update(casesText).digest('hex')

// ---- static contract: fixture provenance and the pinned OpenAPI surface
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
assert.deepEqual(methods('/vendor'), ['get', 'post'])
assert.deepEqual(methods('/vendor/{vendor_id}'), ['delete', 'get', 'patch'])
assert.deepEqual(methods('/filament'), ['get', 'post'])
assert.deepEqual(methods('/filament/{filament_id}'), ['delete', 'get', 'patch'])
const vendorQuery = spec.paths['/vendor'].get.parameters.map((p) => p.name)
assert.deepEqual(vendorQuery, [
  'name',
  'external_id',
  'sort',
  'limit',
  'offset',
])
const filamentQuery = spec.paths['/filament'].get.parameters.map((p) => p.name)
for (const name of [
  'vendor_name',
  'vendor_id',
  'vendor.name',
  'vendor.id',
  'name',
  'material',
  'article_number',
  'color_hex',
  'color_similarity_threshold',
  'external_id',
  'tag',
  'sort',
  'limit',
  'offset',
])
  assert.ok(filamentQuery.includes(name), `filament query ${name}`)
const schemaKeys = (name) =>
  Object.keys(spec.components.schemas[name].properties)
check('openapi-paths-and-query-parameters-pinned')

assert.deepEqual(classifyLegacyBody(undefined, undefined), { kind: 'none' })
assert.deepEqual(classifyLegacyBody('null', 'application/json'), {
  kind: 'none',
})
assert.deepEqual(classifyLegacyBody('{"a":1}', undefined), {
  kind: 'json',
  value: { a: 1 },
})
assert.deepEqual(
  classifyLegacyBody('{"a":1}', 'application/vnd.x+json; charset=utf-8'),
  { kind: 'json', value: { a: 1 } },
)
assert.deepEqual(classifyLegacyBody('{', 'application/json'), {
  kind: 'invalid-json',
})
assert.deepEqual(classifyLegacyBody('{"a":1}', 'text/plain'), {
  kind: 'raw',
  text: '{"a":1}',
})
const moduleNames = LEGACY_API_MODULES.map((m) => m.name)
for (const name of ['health', 'vendor', 'filament'])
  assert.ok(moduleNames.includes(name), `missing legacy module ${name}`)
check('fastapi-body-classification-and-module-registry')

// ---- disposable PostgreSQL
const evidenceDir = resolve(
  process.env.SPOOL_VENDOR_FILAMENT_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spool-vendor-filament-'))),
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
const containerName = `o3dfm-spool-vf-547-${randomBytes(4).toString('hex')}`
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
  check('migration-0087-down-up-round-trip')
  const role = 'spool_library_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library`
  await admin.unsafe(`ALTER ROLE "${role}" PASSWORD '${fixture.password}'`)
  runtime = postgres({
    host: '127.0.0.1',
    port: fixture.port,
    database: 'fixture',
    username: role,
    password: fixture.password,
    ssl: false,
    max: 4,
    connect_timeout: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
  await validateSpoolLibraryRole(runtime)
  check('migration-0087-role-policy-still-valid')

  let clock = Date.UTC(2026, 10, 21, 8, 0, 0)
  const farms = [randomUUID(), randomUUID()]
  for (let i = 0; i < 2; i++) {
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

  const writeStderr = process.stderr.write
  const call = async (token, method, path, body, contentType) => {
    const [pathname, query = ''] = `/spoolman/${token}${path}`.split('?', 2)
    process.stderr.write = (line) => appOutput.push(String(line)) > 0
    try {
      return await handleLegacyRequest(store, {
        method,
        pathname,
        query: new URLSearchParams(query),
        body:
          body === undefined
            ? classifyLegacyBody(undefined)
            : classifyLegacyBody(body, contentType ?? 'application/json'),
      })
    } finally {
      process.stderr.write = writeStderr
    }
  }
  const json = (value) =>
    value === undefined ? undefined : JSON.stringify(value)
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (k === 'registered') {
            assert.match(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
            return [k, '<timestamp>']
          }
          return [k, normalize(v)]
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

  // ---- replay every recorded upstream answer on farm A
  let replayed = 0
  for (const item of recorded.cases) {
    clock += 1000
    if (item.setup === 'field') {
      assert.equal(item.status, 200, `${item.name}: upstream setup`)
      const [, , , , entity, key] = item.path.split('/')
      const b = item.body
      await admin`INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, sort_order, unit, default_value, choices, multi_choice, source_key, source_sha256, updated_at)
        VALUES (${farms[0]}::uuid, ${entity}, ${key}, ${b.name}, ${b.field_type}, ${b.order ?? 0}, ${b.unit ?? null}, ${b.default_value ?? null}, ${b.choices ? admin.json(b.choices) : null}, ${b.multi_choice ?? false}, 'contract-547', ${createHash('sha256').update(key).digest('hex')}, 1)`
      continue
    }
    if (item.setup === 'spool') {
      assert.equal(item.status, 200, `${item.name}: upstream setup`)
      must(
        await store.withScope({ kind: 'session', ...manage(0) }, (r) =>
          r.spools.create({ filamentId: item.body.filament_id }),
        ),
      )
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
    const total = actual.headers?.['x-total-count'] ?? null
    assert.equal(total, item.total, `${item.name}: x-total-count`)
    if (item.compare === 'status-type')
      assert.equal(
        actual.body.detail[0].type,
        item.response.detail[0].type,
        `${item.name}: error type`,
      )
    else {
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
  assert.ok(replayed > 150, `replayed ${replayed} upstream answers`)
  check(`upstream-v0.27.1-fixtures-replayed-${replayed}`)

  const vendorA = (await call(writeA, 'GET', '/api/v1/vendor?sort=id:asc')).body
  const firstVendor = vendorA[0]
  for (const record of vendorA)
    for (const key of Object.keys(record))
      assert.ok(schemaKeys('Vendor').includes(key), `Vendor.${key}`)
  const filamentA = (await call(writeA, 'GET', '/api/v1/filament')).body
  for (const record of filamentA)
    for (const key of Object.keys(record))
      assert.ok(schemaKeys('Filament').includes(key), `Filament.${key}`)
  check('responses-use-only-openapi-schema-fields')

  // ---- cross-farm isolation: farm B sees nothing of farm A and cannot touch it
  const emptyB = await call(writeB, 'GET', '/api/v1/vendor')
  assert.deepEqual(
    [emptyB.status, emptyB.body, emptyB.headers['x-total-count']],
    [200, [], '0'],
  )
  const filamentsB = await call(writeB, 'GET', '/api/v1/filament?limit=5')
  assert.deepEqual(
    [filamentsB.body, filamentsB.headers['x-total-count']],
    [[], '0'],
  )
  const otherId = firstVendor.id
  assert.equal(
    (await call(writeB, 'GET', `/api/v1/vendor/${otherId}`)).status,
    404,
  )
  assert.equal(
    (
      await call(
        writeB,
        'PATCH',
        `/api/v1/vendor/${otherId}`,
        '{"name":"stolen"}',
      )
    ).status,
    404,
  )
  assert.equal(
    (await call(writeB, 'DELETE', `/api/v1/vendor/${otherId}`)).status,
    404,
  )
  assert.equal(
    (await call(writeB, 'GET', `/api/v1/filament/${filamentA[0].id}`)).status,
    404,
  )
  const crossVendor = await call(
    writeB,
    'POST',
    '/api/v1/filament',
    JSON.stringify({ density: 1, diameter: 1.75, vendor_id: otherId }),
  )
  assert.deepEqual(
    [crossVendor.status, crossVendor.body],
    [404, { message: `No vendor with ID ${otherId} found.` }],
  )
  const ownB = await call(writeB, 'POST', '/api/v1/vendor', '{"name":"Only B"}')
  assert.equal(ownB.body.id, 1, 'ids are allocated per farm')
  const afterA = (await call(writeA, 'GET', '/api/v1/vendor?sort=id:asc')).body
  assert.deepEqual(afterA, vendorA, 'farm A unchanged by farm B traffic')
  assert.deepEqual(
    (await call(writeB, 'GET', '/api/v1/vendor?name=Only')).body.map(
      (v) => v.name,
    ),
    ['Only B'],
  )
  check('cross-farm-isolation-for-every-vendor-and-filament-method')

  // ---- read credential: reads work, every mutation is refused before validation
  assert.equal((await call(readA, 'GET', '/api/v1/vendor')).status, 200)
  for (const [method, path, body] of [
    ['POST', '/api/v1/vendor', '{"name":"x"}'],
    ['POST', '/api/v1/vendor', '{'],
    ['PATCH', `/api/v1/vendor/${otherId}`, '{"name":"x"}'],
    ['DELETE', `/api/v1/vendor/${otherId}`],
    ['POST', '/api/v1/filament', '{"density":1,"diameter":1}'],
    ['PATCH', `/api/v1/filament/${filamentA[0].id}`, '{}'],
    ['DELETE', `/api/v1/filament/${filamentA[0].id}`],
  ]) {
    const denied = await call(readA, method, path, body)
    assert.deepEqual(
      [denied.status, denied.body],
      [403, { message: 'Forbidden' }],
      `${method} ${path}`,
    )
  }
  assert.deepEqual(
    (await call(writeA, 'GET', '/api/v1/vendor?sort=id:asc')).body,
    vendorA,
  )
  check('read-credential-cannot-mutate')

  // ---- no unauthenticated access, whatever the path or method
  const forged = `sl1.${writeA.split('.')[1]}.${writeB.split('.')[2]}`
  for (const token of ['invalid', forged, writeA + 'x', ''])
    for (const [method, path] of [
      ['GET', '/api/v1/vendor'],
      ['POST', '/api/v1/filament'],
      ['DELETE', '/api/v1/vendor/1'],
    ]) {
      const rejected = await call(
        token,
        method,
        path,
        '{"density":1,"diameter":1}',
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
  assert.equal((await call(writeB, 'GET', '/api/v1/vendor')).status, 401)
  assert.equal((await call(writeA, 'GET', '/api/v1/vendor')).status, 200)
  check('invalid-forged-and-revoked-credentials-rejected')

  // ---- the dispatcher takes additional modules without changes
  const probe = {
    name: 'probe',
    async handle(repository, request) {
      if (request.apiPath !== '/api/v1/probe') return undefined
      return {
        ok: true,
        value: {
          status: 200,
          body: {
            farm: repository.farmId === farms[0],
            q: request.query.get('q'),
          },
        },
      }
    },
  }
  const extended = await handleLegacyRequest(
    store,
    {
      method: 'GET',
      pathname: `/spoolman/${writeA}/api/v1/probe`,
      query: new URLSearchParams('q=1'),
    },
    [...LEGACY_API_MODULES, probe],
  )
  assert.deepEqual(extended.body, { farm: true, q: '1' })
  const unclaimed = await call(writeA, 'GET', '/api/v1/unclaimed-endpoint')
  assert.deepEqual(
    [unclaimed.status, unclaimed.body],
    [404, { detail: 'Not Found' }],
  )
  check('module-interface-extends-dispatcher')

  const fullLog = await exec('docker', ['logs', containerName], {
    maxBuffer: 64 * 1024 * 1024,
  }).then((r) => r.stdout + r.stderr)
  assert.ok(
    fullLog.includes('spool_vendors'),
    'statement logging must be active',
  )
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
    {
      mode: 0o600,
    },
  ).catch(() => {})
  console.error(`FAILED after ${checks.length} checks: ${text.slice(0, 4000)}`)
  console.error(`Diagnostics retained in ${evidenceDir}`)
} finally {
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
