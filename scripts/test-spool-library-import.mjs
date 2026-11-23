// Evidence for importing existing spool libraries (migration 0086).
//
// Two task-owned Docker containers, nothing else listens anywhere:
//   * PostgreSQL 17 (digest-pinned local image, never pulled, loopback port)
//   * a mock of an existing Spoolman (tests/helpers/spoolman-import-mock-server.mjs
//     in the local node:24 image, loopback port, read-only root, no capabilities)
// The importer itself runs in-process in this script. No printer, host service or
// other task's resource is touched.
//
//   node scripts/test-spool-library-import.mjs
//
// Optional: SPOOL_IMPORT_EVIDENCE_DIR (ledger + diagnostics, outside the repo),
// SPOOL_IMPORT_PG_IMAGE (a postgres:17@sha256:... reference present locally),
// SPOOL_IMPORT_MOCK_IMAGE (a node image reference present locally).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
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
import { loadMigrationCatalog, runMigrations } from './db/migrations.ts'
import { PostgresSpoolLibrary } from '../apps/farm/server/storage/postgres-spool-library.ts'
import { PostgresSpoolLibraryImport } from '../apps/farm/server/storage/postgres-spool-library-import.ts'
import { validateSpoolImportRole } from '../apps/farm/server/utils/spool-library-import/role-policy.ts'
import {
  runSpoolLibraryImport,
  spoolLibraryImportBody,
} from '../apps/farm/server/utils/spool-library-import/pipeline.ts'

const exec = promisify(execFile)
const MIGRATION = '0086_spool_library_import'
const LIBRARY_MIGRATION = '0087_spoolman_vendor_filament'
const TASK_LABEL = 'spool-import-544'
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const mockFile = join(repoRoot, 'tests/helpers/spoolman-import-mock-server.mjs')

if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spool-library-import.mjs',
  )

// --- external evidence directory (ledger + retained diagnostics) ------------
const evidenceDir = resolve(
  process.env.SPOOL_IMPORT_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spool-import-'))),
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

// --- local Docker only ------------------------------------------------------
const docker = async (...args) =>
  (
    await exec('docker', args, {
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim()
const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
const pgImage =
  process.env.SPOOL_IMPORT_PG_IMAGE ??
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
  pgImage,
  POSTGRES_IMAGE_PATTERN,
  'A digest-pinned postgres:17 image must already exist locally',
)
const mockImage =
  process.env.SPOOL_IMPORT_MOCK_IMAGE ?? 'node:24.22.2-bookworm-slim'
await docker('image', 'inspect', mockImage, '--format', '{{.Id}}') // never pulled

process.env.OPENFARM_PG = 'docker'
const suffix = randomBytes(4).toString('hex')
const pgName = `o3dfm-spool-import-544-pg-${suffix}`
const mockName = `o3dfm-spool-import-544-mock-${suffix}`
const fixture = disposablePostgres({
  name: pgName,
  labelKey: 'o3dfm.task',
  labelValue: TASK_LABEL,
  docker,
  image: pgImage,
  ledger,
  through: MIGRATION,
  // Statement logging on, so the evidence can prove no secret reaches server logs.
  postgresArgs: ['-c', 'log_statement=all', '-c', 'log_min_messages=info'],
})

const checks = []
const check = (name) => checks.push(name)
let admin
let importSql
let librarySql
let mockOrigin
let failure
const UPSTREAM_TOKEN = 'upstream-secret-' + randomBytes(16).toString('hex')
const secrets = [UPSTREAM_TOKEN]

// --- the mock Spoolman, in its own container --------------------------------
async function startMock() {
  const mockLabel = `o3dfm.task=${TASK_LABEL}`
  ledger({
    resource: 'container',
    name: mockName,
    label: mockLabel,
    image: mockImage,
  })
  await docker(
    ...['create', '--name', mockName, '--label', mockLabel, '--pull', 'never'],
    ...['--cpus', '0.5', '--memory', '256m', '--pids-limit', '64'],
    ...[
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
    ],
    ...['--user', 'node', '-p', '127.0.0.1::8000'],
    ...['-v', `${mockFile}:/srv/mock.mjs:ro`],
    mockImage,
    'node',
    '/srv/mock.mjs',
  )
  const id = await docker('inspect', '--format', '{{.Id}}', mockName)
  assert.match(id, /^[a-f0-9]{64}$/)
  ledger({ resource: 'container-id', name: mockName, id })
  await docker('start', id)
  const mapping = await docker('port', id, '8000/tcp')
  assert.match(mapping, /^127\.0\.0\.1:[0-9]+$/)
  mockOrigin = `http://${mapping}`
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${mockOrigin}/__mock/requests`)).ok) return
    } catch {}
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error('Mock Spoolman did not become ready')
}
const control = async (what, body) => {
  const response = await fetch(`${mockOrigin}/__mock/${what}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
}
const mockRequests = async () =>
  (await fetch(`${mockOrigin}/__mock/requests`)).json()

// --- upstream dataset (shapes of Spoolman 0.27.1) ---------------------------
function dataset() {
  const vendors = [
    {
      id: 1,
      registered: '2024-03-01T10:00:00Z',
      name: 'Polymaker',
      comment: 'cn',
      empty_spool_weight: 140,
      external_id: 'polymaker',
      extra: { origin: '"CN"' },
    },
    {
      id: 2,
      registered: '2024-03-02T10:00:00Z',
      name: 'eSun',
      comment: null,
      empty_spool_weight: null,
      external_id: null,
      extra: {},
    },
  ]
  const filaments = [
    {
      id: 1,
      registered: '2024-03-03T10:00:00Z',
      name: 'PLA Blue',
      vendor: vendors[0],
      material: 'PLA',
      price: 25,
      density: 1.24,
      diameter: 1.75,
      weight: 1000,
      spool_weight: 140,
      article_number: 'A-1',
      comment: 'blue',
      settings_extruder_temp: 210,
      settings_bed_temp: 60,
      color_hex: '0000FF',
      multi_color_hexes: null,
      multi_color_direction: null,
      external_id: null,
      extra: { finish: '"matte"' },
    },
    {
      id: 2,
      registered: '2024-03-04T10:00:00Z',
      name: 'PETG Red',
      vendor: vendors[1],
      material: 'PETG',
      price: null,
      density: 1.27,
      diameter: 1.75,
      weight: 1000,
      spool_weight: null,
      article_number: null,
      comment: null,
      settings_extruder_temp: 235,
      settings_bed_temp: 80,
      color_hex: 'FF0000',
      external_id: null,
      extra: {},
    },
    {
      id: 3,
      registered: '2024-03-05T10:00:00Z',
      name: 'TPU Clear',
      vendor: null,
      material: 'TPU',
      price: 30,
      density: 1.2,
      diameter: 1.75,
      weight: 500,
      spool_weight: 120,
      color_hex: 'FFFFFF',
      external_id: null,
      extra: {},
    },
  ]
  const spools = Array.from({ length: 450 }, (_, i) => {
    const id = i + 1
    const filament = filaments[i % 3]
    return {
      id,
      registered: '2024-04-01T08:00:00Z',
      first_used: id % 5 === 0 ? '2024-04-02T08:00:00Z' : null,
      last_used: id % 5 === 0 ? '2024-04-03T08:00:00Z' : null,
      filament,
      price: 20,
      initial_weight: 1000,
      spool_weight: 140,
      used_weight: id % 100,
      remaining_weight: 1000 - (id % 100),
      location: id === 1 ? 'shelf A1' : `shelf-${(id % 9) + 1}`,
      lot_nr: id === 2 ? 'LOT-2' : null,
      comment: null,
      archived: id % 50 === 0,
      extra: { slot: `"${id % 12}"` },
    }
  })
  const fields = {
    vendor: [
      {
        key: 'origin',
        name: 'Origin',
        order: 0,
        unit: null,
        field_type: 'text',
        default_value: null,
        choices: null,
        multi_choice: false,
      },
    ],
    filament: [
      {
        key: 'finish',
        name: 'Finish',
        order: 1,
        unit: null,
        field_type: 'choice',
        default_value: null,
        choices: ['matte', 'glossy'],
        multi_choice: false,
      },
    ],
    spool: [
      {
        key: 'slot',
        name: 'Slot',
        order: 0,
        unit: '#',
        field_type: 'integer',
        default_value: '0',
        choices: null,
        multi_choice: false,
      },
    ],
  }
  const settings = {
    currency: { value: '"EUR"', is_set: true, type: 'string' },
    round_prices: { value: 'false', is_set: false, type: 'boolean' },
    base_url: {
      value: '"https://old-spoolman.example"',
      is_set: true,
      type: 'string',
    },
    extra_fields_spool: { value: '[]', is_set: true, type: 'array' },
    print_presets: { value: '[{"name":"a"}]', is_set: true, type: 'array' },
  }
  return { vendors, filaments, spools, fields, settings }
}

try {
  admin = await fixture.start()
  ledger({
    resource: 'container',
    name: pgName,
    image: pgImage,
    port: fixture.port,
  })
  await startMock()

  // --- migration 0086 round trip (it is the last applied migration) ---------
  const full = await loadMigrationCatalog()
  const catalog = full.slice(0, full.findIndex((m) => m.id === MIGRATION) + 1)
  assert.equal(catalog.at(-1).id, MIGRATION)
  const tableCount = async () =>
    (
      await admin`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='farm' AND c.relname IN ('spool_import_runs','spool_import_identities','spool_library_fields','spool_library_settings')`
    )[0].n
  assert.equal(await tableCount(), 4)
  await runMigrations(admin, catalog, {
    kind: 'down',
    expectedLastId: MIGRATION,
  })
  assert.equal(await tableCount(), 0)
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM pg_roles WHERE rolname='farm_spool_import'`
    )[0].n,
    0,
  )
  await runMigrations(admin, catalog, { kind: 'up' })
  assert.equal(await tableCount(), 4)
  check('migration-0086-down-up-round-trip')
  // The library repository reads the vendor/filament columns added by 0087.
  await runMigrations(
    admin,
    full.slice(0, full.findIndex((m) => m.id === LIBRARY_MIGRATION) + 1),
    { kind: 'up' },
  )

  // --- least-privilege roles --------------------------------------------------
  const login = (role, port = fixture.port) =>
    postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: role,
      password: fixture.password,
      ssl: false,
      max: 8,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { search_path: 'pg_catalog' },
    })
  const importRole = 'spool_import_' + randomUUID().replaceAll('-', '')
  const libraryRole = 'spool_lib_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(importRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_import`
  await admin.unsafe(
    `ALTER ROLE "${importRole}" PASSWORD '${fixture.password}'`,
  )
  await admin`CREATE ROLE ${admin(libraryRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library`
  await admin.unsafe(
    `ALTER ROLE "${libraryRole}" PASSWORD '${fixture.password}'`,
  )
  importSql = login(importRole)
  librarySql = login(libraryRole)
  await validateSpoolImportRole(importSql)
  await assert.rejects(
    validateSpoolImportRole(admin),
    /Invalid spool import database role/,
  )
  await assert.rejects(
    validateSpoolImportRole(librarySql),
    /Invalid spool import database role/,
  )
  const sqlState = async (promise) => {
    try {
      await promise
    } catch (error) {
      return error.code
    }
    return 'no-error'
  }

  // --- seed: farms, members ------------------------------------------------------
  const farms = Object.fromEntries(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((k) => [k, randomUUID()]),
  )
  for (const farm of Object.values(farms))
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
  const people = {
    ownerA: [farms.A, 'owner'],
    adminA: [farms.A, 'admin'],
    operatorA: [farms.A, 'operator'],
    viewerA: [farms.A, 'viewer'],
    ownerB: [farms.B, 'owner'],
    ownerC: [farms.C, 'owner'],
    ownerD: [farms.D, 'owner'],
    ownerE: [farms.E, 'owner'],
    ownerF: [farms.F, 'owner'],
    ownerG: [farms.G, 'owner'],
    stranger: [null, null],
  }
  for (const [who, [farm, role]] of Object.entries(people)) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${'acc-' + who})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${'s-' + who}, ${'acc-' + who}, 0, 100, 100, 10000000)`
    if (farm)
      await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${'acc-' + who}, ${role})`
  }
  // The farm's existing external Spoolman connector setting must survive every import.
  const agentId = randomUUID()
  await admin`INSERT INTO farm.spoolman_connector_settings (farm_id, agent_id, origin, status, configured, checked_at, updated_by)
    VALUES (${farms.A}::uuid, ${agentId}::uuid, 'http://192.168.1.60:7912', 'reachable', true, 1, 'acc-ownerA')`
  const connectorFingerprint = async () =>
    JSON.stringify(
      await admin`SELECT row_to_json(c)::text AS r FROM farm.spoolman_connector_settings c ORDER BY farm_id, agent_id`,
    )
  const connectorBefore = await connectorFingerprint()

  const nowMs = 500
  const importer = new PostgresSpoolLibraryImport(importSql, () => nowMs)
  const library = new PostgresSpoolLibrary(librarySql, () => nowMs)
  const authority = (who, farmId) => ({
    sessionRecordId: 's-' + who,
    policy: { idleTimeoutMs: 1_000_000 },
    farmId: farmId ?? people[who][0],
  })
  const session = (who, farmId) => ({
    kind: 'session',
    ...authority(who, farmId),
  })
  const deps = () => ({ importer, allowedOrigins: [mockOrigin] })
  const run = (who, body, farmId) =>
    runSpoolLibraryImport(
      authority(who, farmId),
      spoolLibraryImportBody.parse(body),
      deps(),
    )
  const api = (extra = {}) => ({
    format: 'spoolman-api',
    origin: mockOrigin,
    bearerToken: UPSTREAM_TOKEN,
    ...extra,
  })
  const must = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.report ?? result.value
  }
  const reason = (result) => (result.ok ? 'ok' : result.reason)
  const rowsOf = async (table, farm) =>
    admin`SELECT count(*)::int AS n FROM ${admin('farm.' + table)} WHERE farm_id=${farm}::uuid`.then(
      (r) => r[0].n,
    )
  const fingerprint = async (table, farm, order = 'id') =>
    (
      await admin`SELECT md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY ${admin(order)}), '')) AS h FROM ${admin('farm.' + table)} t WHERE farm_id=${farm}::uuid`
    )[0].h
  const everything = async (farm) =>
    JSON.stringify(
      await Promise.all(
        [
          'spool_vendors',
          'spool_filaments',
          'spools',
          'spool_library_counters',
          'spool_import_runs',
          'spool_import_identities',
          'spool_library_fields',
          'spool_library_settings',
        ].map(async (t) => [
          t,
          await admin`SELECT row_to_json(x)::text AS r FROM ${admin('farm.' + t)} x WHERE farm_id=${farm}::uuid ORDER BY 1`,
        ]),
      ),
    )

  const upstream = dataset()
  await control('state', upstream)
  await control('mode', { token: UPSTREAM_TOKEN })

  // --- who may import ---------------------------------------------------------
  const probe = {
    format: 'json',
    data: { vendors: [{ id: 1, name: 'probe' }] },
  }
  assert.equal(reason(await run('operatorA', probe)), 'denied')
  assert.equal(reason(await run('viewerA', probe)), 'denied')
  assert.equal(reason(await run('stranger', probe, farms.A)), 'forbidden')
  assert.equal(
    reason(await run('ownerB', probe, farms.A)),
    'forbidden',
    'another farm owner cannot import into this farm',
  )
  assert.equal(
    reason(await run('ownerA', probe, 'not-a-uuid')),
    'invalid-input',
  )
  assert.equal(
    reason(
      await runSpoolLibraryImport(
        { ...authority('ownerA'), sessionRecordId: 's-ownerB' },
        spoolLibraryImportBody.parse(probe),
        deps(),
      ),
    ),
    'forbidden',
    "another farm's session cannot be pointed at this farm",
  )
  assert.equal(
    await rowsOf('spool_import_runs', farms.A),
    0,
    'unauthorized attempts leave no trace',
  )
  assert.equal(await rowsOf('spool_vendors', farms.A), 0)
  check('only-owners-and-admins-of-the-farm-can-import')

  // --- API import from the Dockerized Spoolman --------------------------------
  assert.equal(
    reason(
      await run('ownerA', api({ bearerToken: 'wrong-' + UPSTREAM_TOKEN })),
    ),
    'source-unauthorized',
  )
  assert.equal(
    await rowsOf('spool_import_runs', farms.A),
    0,
    'a failed read writes nothing',
  )
  assert.equal(
    reason(await run('ownerA', { ...api(), origin: 'http://127.0.0.1:1' })),
    'source-not-allowed',
  )
  assert.equal(
    reason(
      await run('ownerA', {
        ...api(),
        origin: `http://user:pw@${mockOrigin.slice(7)}`,
      }),
    ),
    'invalid-input',
    'credentials in a URL are refused',
  )
  const first = must(await run('adminA', api()))
  assert.deepEqual(first.vendors, {
    created: 2,
    updated: 0,
    unchanged: 0,
    adopted: 0,
    conflicts: 0,
  })
  assert.equal(first.filaments.created, 3)
  assert.equal(first.spools.created, 450)
  assert.equal(first.fields.created, 3)
  assert.equal(
    first.settings.created,
    2,
    'currency and print_presets; round_prices was never set',
  )
  assert.deepEqual(first.skippedSettings, ['base_url', 'extra_fields_spool'])
  assert.equal(first.truncated, 0)
  assert.equal(first.dryRun, false)
  const sourceKey = first.sourceKey
  assert.match(sourceKey, /^spoolman-[0-9a-f]{16}$/)

  const asViewer = (work) => library.withScope(session('viewerA'), work)
  const vendorsA = must(await asViewer((r) => r.vendors.list({ limit: 50 })))
  assert.deepEqual(
    vendorsA.map((v) => [v.id, v.name]),
    [
      [1, 'Polymaker'],
      [2, 'eSun'],
    ],
  )
  assert.equal(vendorsA[0].registeredAt, Date.parse('2024-03-01T10:00:00Z'))
  assert.deepEqual(vendorsA[0].extra, {
    origin: '"CN"',
    o3dfm_upstream_empty_spool_weight: '140',
  })
  assert.equal(vendorsA[0].externalId, 'polymaker')
  const filamentsA = must(
    await asViewer((r) => r.filaments.list({ limit: 50 })),
  )
  assert.equal(filamentsA.length, 3)
  assert.equal(filamentsA[0].vendorId, 1)
  assert.equal(filamentsA[0].colorHex, '0000FF')
  assert.equal(filamentsA[0].spoolWeight, 140)
  assert.deepEqual(filamentsA[0].extra, {
    finish: '"matte"',
    o3dfm_upstream_article_number: 'A-1',
    o3dfm_upstream_settings_extruder_temp: '210',
    o3dfm_upstream_settings_bed_temp: '60',
  })
  assert.equal(filamentsA[2].vendorId, null)
  let spoolsA = []
  for (let after = 0; ;) {
    const page = must(
      await asViewer((r) => r.spools.list({ limit: 200, afterId: after })),
    )
    spoolsA.push(...page)
    if (page.length < 200) break
    after = page.at(-1).id
  }
  assert.equal(spoolsA.length, 450)
  assert.deepEqual(
    spoolsA.map((s) => s.id),
    Array.from({ length: 450 }, (_, i) => i + 1),
  )
  assert.equal(spoolsA[0].location, 'shelf A1')
  assert.equal(spoolsA[0].filamentId, 1)
  assert.equal(spoolsA[0].archived, false)
  assert.equal(spoolsA[49].archived, true, 'archived spools are imported too')
  assert.equal(spoolsA[4].firstUsedAt, Date.parse('2024-04-02T08:00:00Z'))
  assert.equal(spoolsA[1].lotNr, 'LOT-2')
  assert.deepEqual(spoolsA[0].extra, { slot: '"1"' })
  const fieldsA =
    await admin`SELECT entity_type, key, name, field_type, sort_order, unit, default_value, choices FROM farm.spool_library_fields WHERE farm_id=${farms.A}::uuid ORDER BY entity_type, key`
  assert.deepEqual(
    fieldsA.map((f) => `${f.entity_type}/${f.key}/${f.field_type}`),
    ['filament/finish/choice', 'spool/slot/integer', 'vendor/origin/text'],
  )
  assert.deepEqual(fieldsA[0].choices, ['matte', 'glossy'])
  assert.equal(fieldsA[1].unit, '#')
  const settingsA =
    await admin`SELECT key, value FROM farm.spool_library_settings WHERE farm_id=${farms.A}::uuid ORDER BY key`
  assert.deepEqual(
    settingsA.map((s) => [s.key, s.value]),
    [
      ['currency', 'EUR'],
      ['print_presets', [{ name: 'a' }]],
    ],
  )
  let seen = await mockRequests()
  assert.ok(
    seen.every((r) => r.method === 'GET'),
    'the importer only reads',
  )
  assert.ok(
    seen.filter((r) => r.authorized).every((r) => r.authorization === 'sent'),
  )
  assert.deepEqual(
    seen
      .filter((r) => r.authorized && r.path.startsWith('/api/v1/spool'))
      .map((r) => r.path),
    [
      '/api/v1/spool?limit=200&offset=0&allow_archived=true',
      '/api/v1/spool?limit=200&offset=200&allow_archived=true',
      '/api/v1/spool?limit=200&offset=400&allow_archived=true',
    ],
    'paged through every spool',
  )
  check(
    'spoolman-api-import-brings-vendors-filaments-spools-fields-settings-and-extra',
  )

  // --- repeating the import changes nothing ----------------------------------------
  const before = {
    spools: await fingerprint('spools', farms.A),
    filaments: await fingerprint('spool_filaments', farms.A),
    vendors: await fingerprint('spool_vendors', farms.A),
    counters: await fingerprint('spool_library_counters', farms.A, 'kind'),
    identities: await rowsOf('spool_import_identities', farms.A),
  }
  const second = must(await run('ownerA', api()))
  assert.deepEqual(
    [
      second.vendors,
      second.filaments,
      second.spools,
      second.fields,
      second.settings,
    ].map((c) => [c.created, c.updated, c.adopted, c.conflicts]),
    Array(5).fill([0, 0, 0, 0]),
  )
  assert.equal(second.vendors.unchanged, 2)
  assert.equal(second.filaments.unchanged, 3)
  assert.equal(second.spools.unchanged, 450)
  assert.equal(second.fields.unchanged, 3)
  assert.equal(second.settings.unchanged, 2)
  assert.deepEqual(
    {
      spools: await fingerprint('spools', farms.A),
      filaments: await fingerprint('spool_filaments', farms.A),
      vendors: await fingerprint('spool_vendors', farms.A),
      counters: await fingerprint('spool_library_counters', farms.A, 'kind'),
      identities: await rowsOf('spool_import_identities', farms.A),
    },
    before,
  )
  assert.equal(await rowsOf('spools', farms.A), 450)
  check('repeat-import-is-idempotent')

  // --- upstream changes flow in; removed upstream records are never deleted ----------
  const changed = structuredClone(upstream)
  changed.vendors[0].comment = 'cn-updated'
  changed.filaments[1].vendor = changed.vendors[0] // PETG Red moves to Polymaker
  changed.spools[1].used_weight = 77
  changed.spools = changed.spools.filter((s) => s.id !== 3)
  changed.spools.push({
    ...changed.spools[0],
    id: 451,
    location: 'new shelf',
    filament: changed.filaments[2],
  })
  changed.fields.filament[0].choices = ['matte', 'glossy', 'silk']
  changed.settings.currency.value = '"USD"'
  await control('state', changed)
  const third = must(await run('ownerA', api()))
  assert.deepEqual(
    [
      third.vendors.updated,
      third.filaments.updated,
      third.spools.updated,
      third.spools.created,
      third.spools.unchanged,
    ],
    [1, 1, 1, 1, 448],
  )
  assert.equal(third.fields.updated, 1)
  assert.equal(third.settings.updated, 1)
  assert.equal(must(await asViewer((r) => r.spools.get(2))).usedWeight, 77)
  assert.equal(
    must(await asViewer((r) => r.spools.get(3))).location,
    'shelf-4',
    'spool removed upstream is kept',
  )
  assert.equal(
    must(await asViewer((r) => r.spools.get(451))).location,
    'new shelf',
  )
  assert.equal(must(await asViewer((r) => r.filaments.get(2))).vendorId, 1)
  assert.equal(
    must(await asViewer((r) => r.vendors.get(1))).comment,
    'cn-updated',
  )
  check(
    'changed-upstream-records-update-new-ones-are-created-nothing-is-deleted',
  )

  // --- local edits and conflicts ------------------------------------------------------
  must(
    await library.withScope(session('operatorA'), (r) =>
      r.spools.update(5, { location: 'moved locally' }),
    ),
  )
  const afterEdit = must(await run('ownerA', api()))
  assert.equal(afterEdit.spools.unchanged, 450)
  assert.equal(
    must(await asViewer((r) => r.spools.get(5))).location,
    'moved locally',
    'a local edit survives an unchanged upstream',
  )
  const withComment = structuredClone(changed)
  withComment.spools.find((s) => s.id === 5).comment = 'upstream note'
  await control('state', withComment)
  const conflicted = must(await run('ownerA', api()))
  assert.equal(conflicted.spools.conflicts, 1)
  assert.deepEqual(conflicted.conflicts, [{ kind: 'spool', id: '5' }])
  assert.equal(conflicted.spools.updated, 0)
  assert.equal(
    must(await asViewer((r) => r.spools.get(5))).comment,
    null,
    'keep-local is the default',
  )
  const again = must(await run('ownerA', api()))
  assert.equal(
    again.spools.conflicts,
    1,
    'the same conflict is reported again, nothing else happens',
  )
  const overwritten = must(
    await run('ownerA', api({ onConflict: 'overwrite' })),
  )
  assert.equal(overwritten.spools.updated, 1)
  const five = must(await asViewer((r) => r.spools.get(5)))
  assert.equal(five.comment, 'upstream note')
  assert.equal(five.location, 'shelf-6')
  assert.equal(must(await run('ownerA', api())).spools.unchanged, 450)
  check('local-edits-are-kept-conflicts-reported-overwrite-is-explicit')

  // --- deleting an imported record locally lets the next import recreate it -----------
  const identitiesBefore = await rowsOf('spool_import_identities', farms.A)
  must(await library.withScope(session('operatorA'), (r) => r.spools.delete(7)))
  assert.equal(
    await rowsOf('spool_import_identities', farms.A),
    identitiesBefore - 1,
  )
  const recreated = must(await run('ownerA', api()))
  assert.equal(recreated.spools.created, 1)
  assert.equal(recreated.spools.unchanged, 449)
  check('deleted-local-record-is-recreated-on-the-next-import')

  // --- collisions with data the farm already has ---------------------------------------
  const asB = (work) => library.withScope(session('ownerB'), work)
  const localVendor = must(
    await asB((r) => r.vendors.create({ name: 'polymaker', comment: 'mine' })),
  )
  const localFilament = must(
    await asB((r) =>
      r.filaments.create({
        vendorId: localVendor.id,
        name: 'PLA Blue',
        material: 'PLA',
        colorHex: '0000ff',
        density: 1.24,
        diameter: 1.75,
      }),
    ),
  )
  const localSpool = must(
    await asB((r) =>
      r.spools.create({
        filamentId: localFilament.id,
        comment: 'farm B local spool',
      }),
    ),
  )
  await control('state', upstream)
  const adopted = must(await run('ownerB', api()))
  assert.equal(adopted.vendors.adopted, 1)
  assert.equal(adopted.vendors.created, 1)
  assert.equal(adopted.filaments.adopted, 1)
  assert.equal(adopted.filaments.created, 2)
  assert.equal(
    adopted.spools.created,
    450,
    'a spool has no natural key: never merged',
  )
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.spool_vendors WHERE farm_id=${farms.B}::uuid AND lower(name)='polymaker'`
    )[0].n,
    1,
  )
  assert.equal(
    must(await asB((r) => r.vendors.get(localVendor.id))).comment,
    'mine',
    'an adopted record is not rewritten',
  )
  assert.equal(
    must(await asB((r) => r.spools.get(localSpool.id))).comment,
    'farm B local spool',
  )
  assert.equal(must(await run('ownerB', api())).spools.unchanged, 450)
  // Farm C: the farm asks for duplicates instead of adopting.
  const localE = must(
    await library.withScope(session('ownerC'), (r) =>
      r.vendors.create({ name: 'eSun' }),
    ),
  )
  const duplicated = must(await run('ownerC', api({ onCollision: 'create' })))
  assert.equal(duplicated.vendors.created, 2)
  assert.equal(duplicated.vendors.adopted, 0)
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.spool_vendors WHERE farm_id=${farms.C}::uuid AND name='eSun'`
    )[0].n,
    2,
  )
  assert.ok(localE.id >= 1)
  check('collisions-adopt-by-natural-key-or-duplicate-on-request')

  // --- farms never see each other ---------------------------------------------------------
  assert.equal(
    await rowsOf('spools', farms.A),
    451,
    'farm A kept its own spool set',
  )
  const aSpoolsText = JSON.stringify(spoolsA)
  assert.ok(!aSpoolsText.includes('farm B local spool'))
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.spool_import_identities i WHERE i.farm_id=${farms.A}::uuid AND i.source_key <> ${sourceKey}`
    )[0].n,
    0,
  )
  const onlyInB = must(
    await asB((r) => r.vendors.create({ name: 'only in farm B' })),
  )
  assert.ok(onlyInB.id > 2, 'farm A has no vendor with this id')
  assert.equal(
    await sqlState(
      importSql`INSERT INTO farm.spool_import_identities (farm_id, source_key, kind, upstream_id, vendor_id, source_sha256, applied_sha256, first_run_id, updated_run_id)
        SELECT ${farms.A}::uuid, 'x', 'vendor', '99', ${onlyInB.id}, repeat('0',64), repeat('0',64), r.id, r.id FROM farm.spool_import_runs r
        WHERE r.farm_id=${farms.A}::uuid LIMIT 1`,
    ),
    '23503',
    'raw SQL cannot link farm A identity to a farm B record',
  )
  const farmBIds = (
    await admin`SELECT upstream_id, vendor_id::int AS v FROM farm.spool_import_identities WHERE farm_id=${farms.B}::uuid AND kind='vendor' ORDER BY upstream_id`
  ).map((r) => [r.upstream_id, r.v])
  assert.deepEqual(
    farmBIds,
    [
      ['1', localVendor.id],
      ['2', localVendor.id + 1],
    ],
    'farm B has its own id space',
  )
  assert.equal(await sqlState(importSql`DELETE FROM farm.spools`), '42501')
  assert.equal(
    await sqlState(importSql`UPDATE farm.spools SET farm_id=${farms.B}::uuid`),
    '42501',
  )
  assert.equal(
    await sqlState(
      importSql`UPDATE farm.spool_import_identities SET farm_id=${farms.B}::uuid`,
    ),
    '42501',
  )
  assert.equal(
    await sqlState(importSql`SELECT 1 FROM farm.connector_enrollments LIMIT 1`),
    '42501',
  )
  assert.equal(
    await sqlState(
      importSql`UPDATE farm.spoolman_connector_settings SET origin='http://x'`,
    ),
    '42501',
  )
  check('imports-stay-inside-their-farm-and-the-database-backstops-it')

  // --- the external connector option is untouched --------------------------------------------
  assert.equal(await connectorFingerprint(), connectorBefore)
  check('external-connector-settings-are-untouched')

  // --- failures: nothing partial survives ----------------------------------------------------------
  await admin.unsafe(`
    CREATE FUNCTION farm.poison_spool() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.comment = 'poison' THEN RAISE EXCEPTION 'poisoned' USING ERRCODE = '23514'; END IF;
      IF NEW.comment = 'poison-outage' THEN RAISE EXCEPTION 'poisoned' USING ERRCODE = '58000'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER poison_spool BEFORE INSERT ON farm.spools FOR EACH ROW EXECUTE FUNCTION farm.poison_spool();`)
  const small = (comment3) => ({
    format: 'json',
    source: 'poison-test',
    data: {
      vendors: [{ id: 1, name: 'V' }],
      filaments: [
        { id: 1, vendor_id: 1, name: 'F', density: 1.2, diameter: 1.75 },
      ],
      fields: [
        {
          key: 'k1',
          name: 'K',
          order: 0,
          field_type: 'text',
          entity_type: 'spool',
        },
      ],
      settings: { currency: '"BRL"' },
      spools: [
        { id: 1, filament_id: 1, comment: 'ok' },
        { id: 2, filament_id: 1, comment: 'ok' },
        { id: 3, filament_id: 1, comment: comment3 },
      ],
    },
  })
  const tables = [
    'spool_vendors',
    'spool_filaments',
    'spools',
    'spool_library_counters',
    'spool_import_identities',
    'spool_library_fields',
    'spool_library_settings',
  ]
  const emptyD = async () => {
    for (const t of tables)
      assert.equal(
        await rowsOf(t, farms.D),
        0,
        `${t} must be empty after a failed import`,
      )
  }
  assert.equal(reason(await run('ownerD', small('poison'))), 'invalid-input')
  await emptyD()
  assert.equal(
    reason(await run('ownerD', small('poison-outage'))),
    'storage-unavailable',
  )
  await emptyD()
  const failedRuns =
    await admin`SELECT status, error_code FROM farm.spool_import_runs WHERE farm_id=${farms.D}::uuid ORDER BY started_at, id`
  assert.deepEqual(failedRuns.map((r) => [r.status, r.error_code]).sort(), [
    ['failed', 'invalid-input'],
    ['failed', 'storage-unavailable'],
  ])
  // The same payload imports cleanly once the cause is gone: no half-state to collide with.
  await admin`DROP TRIGGER poison_spool ON farm.spools`
  const recovered = must(await run('ownerD', small('ok')))
  assert.deepEqual(
    [
      recovered.vendors.created,
      recovered.filaments.created,
      recovered.spools.created,
      recovered.fields.created,
      recovered.settings.created,
    ],
    [1, 1, 3, 1, 1],
  )
  assert.equal(must(await run('ownerD', small('ok'))).spools.unchanged, 3)
  check('failure-halfway-rolls-the-whole-run-back-and-leaves-only-an-audit-row')

  // References that cannot be resolved, and invalid data, are refused before any write.
  const orphan = await run('ownerD', {
    format: 'json',
    source: 'orphans',
    data: { spools: [{ id: 1, filament_id: 99 }] },
  })
  assert.equal(reason(orphan), 'unresolved-reference')
  assert.deepEqual(
    orphan.problems.map((p) => p.path),
    ['spools[id=1].filament'],
  )
  assert.equal(
    reason(
      await run('ownerD', {
        format: 'json',
        source: 'poison-test',
        data: {
          spools: [
            { id: 9, filament_id: 1 },
            { id: 9, filament_id: 1 },
          ],
        },
      }),
    ),
    'invalid-input',
  )
  const bad = await run('ownerD', {
    format: 'json',
    data: {
      vendors: [{ name: 'no id' }, { id: 2, name: '' }],
      filaments: [{ id: 3, density: -1, diameter: 1.75 }],
      spools: [
        {
          id: 4,
          filament_id: 3,
          used_weight: -5,
          extra: { Bad_Key: 'x', ok: { nested: 1 } },
        },
      ],
      fields: [
        { key: 'Bad', name: 'x', field_type: 'nope', entity_type: 'spool' },
      ],
    },
  })
  assert.equal(reason(bad), 'invalid-input')
  assert.ok(
    bad.problems.length >= 6 && bad.problems.every((p) => p.path && p.problem),
  )
  assert.ok(
    !JSON.stringify(bad).includes('nested') &&
      !JSON.stringify(bad).includes('no id'),
    'values are not echoed',
  )
  assert.equal(await rowsOf('spool_vendors', farms.D), 1)
  check('unresolved-references-and-invalid-data-are-refused-without-writes')

  // A source that fails at any point changes nothing.
  const hashesA = [
    await fingerprint('spools', farms.A),
    await fingerprint('spool_vendors', farms.A),
  ]
  const runsA = await rowsOf('spool_import_runs', farms.A)
  await control('mode', {
    token: UPSTREAM_TOKEN,
    fail: { path: '/api/v1/spool', status: 500, after: 1 },
  })
  assert.equal(
    reason(await run('ownerA', api())),
    'source-unavailable',
    'upstream fails on its second spool page',
  )
  await control('mode', { token: UPSTREAM_TOKEN, redirect: true })
  assert.equal(
    reason(await run('ownerA', api())),
    'source-unavailable',
    'redirects are refused',
  )
  await control('mode', { token: UPSTREAM_TOKEN, plain: true })
  assert.equal(reason(await run('ownerA', api())), 'source-invalid')
  await control('mode', { token: UPSTREAM_TOKEN, huge: true })
  assert.equal(reason(await run('ownerA', api())), 'source-too-large')
  await control('mode', {
    token: UPSTREAM_TOKEN,
    fail: { path: '/api/v1/setting', status: 503 },
  })
  assert.equal(reason(await run('ownerA', api())), 'source-unavailable')
  await control('mode', { token: UPSTREAM_TOKEN })
  assert.deepEqual(
    [
      await fingerprint('spools', farms.A),
      await fingerprint('spool_vendors', farms.A),
    ],
    hashesA,
  )
  assert.equal(await rowsOf('spool_import_runs', farms.A), runsA)
  seen = await mockRequests()
  assert.ok(seen.every((r) => r.method === 'GET'))
  check('source-failures-leave-the-farm-unchanged')

  // --- dry run -------------------------------------------------------------------------------------
  const dBefore = await everything(farms.D)
  const dry = must(
    await run('ownerD', {
      ...small('ok'),
      data: {
        ...small('ok').data,
        spools: [
          ...small('ok').data.spools,
          { id: 4, filament_id: 1, comment: 'new' },
        ],
      },
      dryRun: true,
    }),
  )
  assert.equal(dry.dryRun, true)
  assert.equal(dry.spools.created, 1)
  assert.equal(dry.spools.unchanged, 3)
  const dAfter = JSON.parse(await everything(farms.D))
  const runsOnly = (all) =>
    JSON.parse(all).filter(([t]) => t !== 'spool_import_runs')
  assert.deepEqual(
    dAfter.filter(([t]) => t !== 'spool_import_runs'),
    runsOnly(dBefore),
  )
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.spool_import_runs WHERE farm_id=${farms.D}::uuid AND status='dry-run'`
    )[0].n,
    1,
  )
  check('dry-run-reports-and-writes-nothing-but-an-audit-row')

  // --- concurrent identical imports ------------------------------------------------------------------
  const [c1, c2] = await Promise.all([
    run('ownerE', api()),
    run('ownerE', api()),
  ])
  const total = (key) => must(c1)[key].created + must(c2)[key].created
  assert.deepEqual(
    [total('vendors'), total('filaments'), total('spools')],
    [2, 3, 450],
  )
  assert.equal(await rowsOf('spools', farms.E), 450)
  assert.equal(await rowsOf('spool_vendors', farms.E), 2)
  check('concurrent-identical-imports-create-each-record-once')

  // --- JSON import -------------------------------------------------------------------------------------
  const nested = {
    spools: [
      {
        id: 11,
        registered: '2024-05-01T00:00:00',
        filament: {
          id: 21,
          name: 'ABS Black',
          material: 'ABS',
          density: 1.04,
          diameter: 1.75,
          vendor: { id: 31, name: 'Prusament' },
        },
        initial_weight: 1000,
        used_weight: 100,
        extra: { slot: '"3"' },
      },
      {
        id: 12,
        filament: {
          id: 21,
          name: 'ABS Black',
          material: 'ABS',
          density: 1.04,
          diameter: 1.75,
          vendor: { id: 31, name: 'Prusament' },
        },
        archived: true,
      },
    ],
  }
  const jsonFirst = must(
    await run('ownerF', {
      format: 'json',
      source: 'backup-2024',
      data: nested,
    }),
  )
  assert.deepEqual(
    [
      jsonFirst.vendors.created,
      jsonFirst.filaments.created,
      jsonFirst.spools.created,
    ],
    [1, 1, 2],
  )
  const jsonAgain = must(
    await run('ownerF', {
      format: 'json',
      source: 'backup-2024',
      data: nested,
    }),
  )
  assert.deepEqual(
    [
      jsonAgain.vendors.unchanged,
      jsonAgain.filaments.unchanged,
      jsonAgain.spools.unchanged,
    ],
    [1, 1, 2],
  )
  // A later partial file from the same source resolves references through earlier imports.
  const partial = must(
    await run('ownerF', {
      format: 'json',
      source: 'backup-2024',
      data: { spools: [{ id: 13, filament_id: 21, used_weight: 1 }] },
    }),
  )
  assert.equal(partial.spools.created, 1)
  assert.equal(
    reason(
      await run('ownerF', {
        format: 'json',
        source: 'someone-else',
        data: { spools: [{ id: 13, filament_id: 21 }] },
      }),
    ),
    'unresolved-reference',
  )
  assert.equal(
    must(await library.withScope(session('ownerF'), (r) => r.spools.get(1)))
      .registeredAt,
    Date.parse('2024-05-01T00:00:00Z'),
  )
  check('json-import-nested-partial-and-repeat')

  // --- CSV import (Spoolman's flattened export layout) -------------------------------------------------------
  const csv = [
    '﻿id,registered,first_used,last_used,price,initial_weight,spool_weight,remaining_weight,used_weight,location,lot_nr,comment,archived,filament.id,filament.name,filament.vendor.id,filament.vendor.name,filament.material,filament.density,filament.diameter,filament.weight,filament.color_hex,extra.slot',
    '1,2024-06-01T09:00:00Z,,,22.5,1000,140,900,100,"Shelf 1, left","LOT-9","two\nlines, ""quoted""",False,5,Silk Gold,6,Elegoo,PLA,1.24,1.75,1000,#FFD700,"""4"""',
    '2,2024-06-02T09:00:00Z,,,,,,,0,,,,True,5,Silk Gold,6,Elegoo,PLA,1.24,1.75,1000,#FFD700,',
  ].join('\r\n')
  const csvFirst = must(
    await run('ownerG', { format: 'csv', entity: 'spools', csv }),
  )
  assert.deepEqual(
    [
      csvFirst.vendors.created,
      csvFirst.filaments.created,
      csvFirst.spools.created,
    ],
    [1, 1, 2],
  )
  const csvSpool = must(
    await library.withScope(session('ownerG'), (r) => r.spools.get(1)),
  )
  assert.equal(csvSpool.location, 'Shelf 1, left')
  assert.equal(csvSpool.comment, 'two\nlines, "quoted"')
  assert.equal(csvSpool.price, 22.5)
  assert.deepEqual(csvSpool.extra, { slot: '"4"' })
  assert.equal(
    must(await library.withScope(session('ownerG'), (r) => r.spools.get(2)))
      .archived,
    true,
  )
  assert.equal(
    must(await library.withScope(session('ownerG'), (r) => r.filaments.get(1)))
      .colorHex,
    'FFD700',
  )
  const csvAgain = must(
    await run('ownerG', { format: 'csv', entity: 'spools', csv }),
  )
  assert.deepEqual(
    [
      csvAgain.vendors.unchanged,
      csvAgain.filaments.unchanged,
      csvAgain.spools.unchanged,
    ],
    [1, 1, 2],
  )
  const vendorsCsv =
    'id,name,comment,extra.origin\n6,Elegoo,renamed comment,"""CN"""\n7,Overture,,\n'
  const vendorsFirst = must(
    await run('ownerG', { format: 'csv', entity: 'vendors', csv: vendorsCsv }),
  )
  assert.deepEqual(
    [vendorsFirst.vendors.updated, vendorsFirst.vendors.created],
    [1, 1],
  )
  const csvBadInputs = {
    'no id column': 'name\nx\n',
    'unterminated quote': 'id,name\n1,"open\n',
    'bad number': 'id,name,density,diameter\n1,x,abc,1.75\n',
    'prototype column': 'id,name,__proto__.x\n1,x,y\n',
  }
  const csvEntity = (title) =>
    title === 'bad number' ? 'filaments' : 'vendors'
  const g0 = await everything(farms.G)
  for (const [title, text] of Object.entries(csvBadInputs))
    assert.equal(
      reason(
        await run('ownerG', {
          format: 'csv',
          entity: csvEntity(title),
          csv: text,
        }),
      ),
      'invalid-input',
      title,
    )
  assert.equal(await everything(farms.G), g0, 'rejected CSV wrote nothing')
  check('csv-import-spoolman-layout-quotes-bom-extra-repeat-and-rejections')

  // --- the library written by the import is the one the foundation serves ---------------------------------------
  assert.equal(
    must(
      await library.withScope(
        { kind: 'session', ...authority('viewerA') },
        (r) => r.spools.list({ limit: 1 }),
      ),
    ).length,
    1,
  )
  check('foundation-repository-serves-imported-data')

  // --- no credential anywhere -------------------------------------------------------------------------------------
  for (const farm of Object.values(farms)) {
    const text = await everything(farm)
    for (const secret of secrets)
      assert.ok(!text.includes(secret), 'upstream token stored')
  }
  const results = JSON.stringify([
    first,
    second,
    third,
    conflicted,
    adopted,
    recovered,
    bad,
  ])
  for (const secret of secrets) assert.ok(!results.includes(secret))
  const unauthorized = await run(
    'ownerA',
    api({ bearerToken: 'wrong-' + UPSTREAM_TOKEN }),
  )
  assert.equal(JSON.stringify(unauthorized).includes('wrong-'), false)
  assert.deepEqual(Object.keys(unauthorized).sort(), ['ok', 'reason'])
  const fullLog = await exec('docker', ['logs', pgName], {
    maxBuffer: 256 * 1024 * 1024,
  }).then((r) => r.stdout + r.stderr)
  assert.ok(
    fullLog.includes('spool_import_identities'),
    'statement logging must be active for this check',
  )
  assert.ok(
    !fullLog.includes(UPSTREAM_TOKEN),
    'the upstream token reached the PostgreSQL log',
  )
  const mockLog = await exec('docker', ['logs', mockName], {
    maxBuffer: 16 * 1024 * 1024,
  }).then((r) => r.stdout + r.stderr)
  assert.ok(!mockLog.includes(UPSTREAM_TOKEN))
  check('no-upstream-credential-in-results-storage-or-server-logs')

  console.log(
    JSON.stringify(
      {
        ok: true,
        containers: [pgName, mockName],
        images: [pgImage, mockImage],
        evidenceDir,
        checks,
      },
      null,
      2,
    ),
  )
} catch (error) {
  failure = error
  process.exitCode = 1
  const diagnostics = {
    error: redact(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
    checksPassed: checks,
    containers: [pgName, mockName],
  }
  await writeFile(
    join(evidenceDir, 'failure.json'),
    JSON.stringify(diagnostics, null, 2),
    { mode: 0o600 },
  ).catch(() => {})
  for (const name of [pgName, mockName])
    await docker('logs', '--tail', '400', name)
      .then((logs) =>
        writeFile(join(evidenceDir, `${name}.log`), redact(logs), {
          mode: 0o600,
        }),
      )
      .catch(() => {})
  console.error(
    `FAILED after ${checks.length} checks: ${redact(error instanceof Error ? error.message : String(error))}`,
  )
  console.error(`Diagnostics retained in ${evidenceDir}`)
} finally {
  await importSql?.end({ timeout: 3 }).catch(() => {})
  await librarySql?.end({ timeout: 3 }).catch(() => {})
  try {
    await fixture.stop()
  } catch (error) {
    console.error(
      `Container removal reported: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
    )
  }
  // Remove only containers carrying this task's label, then verify by exact name.
  let cleanupFailed = false
  for (const name of [pgName, mockName]) {
    let leftover = ''
    for (let attempt = 0; attempt < 45; attempt++) {
      leftover = await docker('ps', '-aq', '--filter', `name=^/${name}$`).catch(
        (e) => `unknown: ${e}`,
      )
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
    ledger({
      cleanup: 'container',
      name,
      remaining: leftover === '' ? 'none' : leftover,
    })
    if (leftover !== '') {
      cleanupFailed = true
      console.error(`Cleanup incomplete: container ${name} still present`)
    }
  }
  if (cleanupFailed) process.exitCode = 1
  else
    console.log(
      `Cleanup: containers ${pgName} and ${mockName} removed; ledger ${ledgerPath}`,
    )
}

/** Diagnostics never keep a credential. */
function redact(text) {
  let out = text
  for (const secret of secrets) out = out.replaceAll(secret, '<redacted>')
  return out
}
