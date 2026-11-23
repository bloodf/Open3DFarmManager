// Evidence for the farm-scoped spool auxiliary & farm features schema (migration 0089).
//
// Starts one disposable PostgreSQL 17 Docker container (digest-pinned local
// image, never pulled, loopback port, read-only root, removed on exit), applies
// all migrations up through 0089, verifies tables, constraints, role policies,
// cross-farm isolation, cost-per-print computation, and down/up rollback, then
// removes the container and verifies removal.
//
//   node scripts/test-spool-features-schema.mjs
//
// Optional: SPOOL_FEATURES_SCHEMA_EVIDENCE_DIR (ledger + diagnostics, outside
// the repo), SPOOL_LIBRARY_TEST_IMAGE (a postgres:17@sha256:... image present locally).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import { validateSpoolLibraryRole } from '../apps/farm/server/utils/spool-library/role-policy.ts'
import { validateSpoolImportRole } from '../apps/farm/server/utils/spool-library-import/role-policy.ts'

const exec = promisify(execFile)
const MIGRATION = '0089_spool_features_schema'
const TASK_LABEL = 'spool-features-schema-545-543'
const NEW_TABLES = [
  'spool_locations',
  'spool_farm_settings',
  'spool_slot_assignments',
  'spool_usage_records',
  'spool_drying_logs',
  'spool_humidity_readings',
]
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spool-features-schema.mjs',
  )

// --- external evidence directory --------------------------------------------
const evidenceDir = resolve(
  process.env.SPOOL_FEATURES_SCHEMA_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spool-features-schema-'))),
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
const containerName = `o3dfm-spool-features-${randomBytes(4).toString('hex')}`
const fixture = disposablePostgres({
  name: containerName,
  labelKey: 'o3dfm.task',
  labelValue: TASK_LABEL,
  docker,
  image,
  ledger,
})

const checks = []
const check = (name) => checks.push(name)
const sqlState = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error?.code ?? 'unknown'
  }
  return 'no-error'
}
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

let admin
let featuresSql
let librarySql
let importSql
const loginRoles = []

const connectAs = async (groupRole) => {
  const name = `${groupRole}_${randomUUID().replaceAll('-', '')}`
  await admin`CREATE ROLE ${admin(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE ${admin(groupRole)}`
  await admin.unsafe(`ALTER ROLE "${name}" PASSWORD '${fixture.password}'`)
  loginRoles.push(name)
  return postgres({
    host: '127.0.0.1',
    port: fixture.port,
    database: 'fixture',
    username: name,
    password: fixture.password,
    ssl: false,
    max: 4,
    connect_timeout: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
}

try {
  const catalog = await loadMigrationCatalog()
  assert.equal(catalog.at(-1)?.id, MIGRATION)
  check('migration-catalog-safety-and-numbering')

  admin = await fixture.start()
  ledger({
    resource: 'container',
    name: containerName,
    image,
    port: fixture.port,
  })

  const countNewTables = async () =>
    (
      await admin`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='farm' AND c.relname = ANY(${NEW_TABLES}::text[])`
    )[0].n
  const hasThresholdColumn = async () =>
    (
      await admin`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='farm' AND table_name='spool_filaments' AND column_name='low_stock_threshold_grams'`
    )[0].n
  const hasFeaturesRole = async () =>
    (
      await admin`SELECT count(*)::int AS n FROM pg_roles WHERE rolname='farm_spool_features'`
    )[0].n

  assert.equal(await countNewTables(), NEW_TABLES.length)
  assert.equal(await hasThresholdColumn(), 1)
  assert.equal(await hasFeaturesRole(), 1)
  check('schema-objects-present-after-up')

  // --- existing role policies remain valid after 0089 -----------------------
  librarySql = await connectAs('farm_spool_library')
  importSql = await connectAs('farm_spool_import')
  featuresSql = await connectAs('farm_spool_features')
  await validateSpoolLibraryRole(librarySql)
  await validateSpoolImportRole(importSql)
  check('existing-spool-role-policies-valid')

  // --- farm_spool_features least-privilege checks ---------------------------
  assert.equal(
    await sqlState(featuresSql`SELECT count(*) FROM farm.password_credentials`),
    '42501',
  )
  assert.equal(
    await sqlState(
      featuresSql`SELECT count(*) FROM farm.spool_library_credentials`,
    ),
    '42501',
  )
  for (const tbl of [
    'spool_library_settings',
    'spool_library_fields',
    ...NEW_TABLES,
  ]) {
    const priv = await featuresSql`
      SELECT has_column_privilege(current_user, ${'farm.' + tbl}, 'farm_id', 'UPDATE') AS farm_update,
             has_table_privilege(current_user, ${'farm.' + tbl}, 'TRUNCATE') AS trunc`
    assert.equal(
      priv[0].farm_update,
      false,
      `${tbl}.farm_id must not be updatable`,
    )
    assert.equal(priv[0].trunc, false, `${tbl} must not allow TRUNCATE`)
  }
  for (const tbl of [
    'spool_farm_settings',
    'spool_slot_assignments',
    'spool_usage_records',
  ]) {
    const del = await featuresSql`
      SELECT has_table_privilege(current_user, ${'farm.' + tbl}, 'DELETE') AS can_delete`
    assert.equal(del[0].can_delete, false, `${tbl} must not allow DELETE`)
  }
  check('farm-spool-features-role-least-privilege')

  // --- seed two isolated farms with printers, jobs, filaments, spools -------
  const farmA = randomUUID()
  const farmB = randomUUID()
  const agentA = randomUUID()
  const agentB = randomUUID()
  const printerA = randomUUID()
  const printerB = randomUUID()
  await admin`INSERT INTO farm.farms (id) VALUES (${farmA}::uuid), (${farmB}::uuid)`
  await admin`INSERT INTO farm.session_accounts (id) VALUES ('acc-a'), ('acc-b')`
  await admin`
    INSERT INTO farm.connector_enrollments (agent_id, farm_id, status, public_key_spki, fingerprint)
    VALUES (${agentA}::uuid, ${farmA}::uuid, 'pending', ${'A'.repeat(59)}, ${'a'.repeat(50)}),
           (${agentB}::uuid, ${farmB}::uuid, 'pending', ${'B'.repeat(59)}, ${'b'.repeat(50)})`
  await admin`
    UPDATE farm.connector_enrollments SET status = 'approved'
    WHERE agent_id IN (${agentA}::uuid, ${agentB}::uuid)`
  await admin`
    INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
    VALUES (${printerA}::uuid, ${farmA}::uuid, ${agentA}::uuid, 'printer-a', 100, 'acc-a'),
           (${printerB}::uuid, ${farmB}::uuid, ${agentB}::uuid, 'printer-b', 100, 'acc-b')`
  const [{ id: jobA }] = await admin`
    INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, filename, ended_at)
    VALUES (${farmA}::uuid, ${agentA}::uuid, 'printer-a', 'completed', 'benchy.gcode', 1000)
    RETURNING id::float8 AS id`
  const [{ id: jobB }] = await admin`
    INSERT INTO farm.job_history (farm_id, agent_id, printer_key, outcome, filename, ended_at)
    VALUES (${farmB}::uuid, ${agentB}::uuid, 'printer-b', 'completed', 'cube.gcode', 1000)
    RETURNING id::float8 AS id`
  for (const farm of [farmA, farmB]) {
    await admin`INSERT INTO farm.spool_vendors (farm_id, id, name, registered_at) VALUES (${farm}::uuid, 1, 'Prusament', 100)`
    await admin`INSERT INTO farm.spool_filaments (farm_id, id, vendor_id, name, material, density, diameter, weight, price, registered_at) VALUES (${farm}::uuid, 1, 1, 'Jet Black', 'PLA', 1.24, 1.75, 1000, 30.0, 100)`
    await admin`INSERT INTO farm.spools (farm_id, id, filament_id, initial_weight, price, registered_at) VALUES (${farm}::uuid, 1, 1, 1000, 25.0, 100)`
    await admin`INSERT INTO farm.spools (farm_id, id, filament_id, initial_weight, price, registered_at) VALUES (${farm}::uuid, 2, 1, 1000, NULL, 100)`
  }

  // --- 1. upstream settings (direct API defaults + imported provenance) -----
  const insertedSettings = await featuresSql`
    INSERT INTO farm.spool_library_settings (farm_id, key, value, updated_at)
    VALUES (${farmA}::uuid, 'currency', ${featuresSql.json('EUR')}, 200),
           (${farmB}::uuid, 'currency', ${featuresSql.json('BRL')}, 200)
    RETURNING farm_id, key, source_key, source_sha256`
  assert.equal(insertedSettings.length, 2)
  assert.equal(insertedSettings[0].source_key, 'local')
  assert.equal(insertedSettings[0].source_sha256, '0'.repeat(64))
  await featuresSql`
    INSERT INTO farm.spool_library_settings (farm_id, key, value, source_key, source_sha256, updated_at)
    VALUES (${farmA}::uuid, 'imported_key', ${featuresSql.json(true)}, 'spoolman-1', ${sha('imported')}, 200)`
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_library_settings (farm_id, key, value, updated_at) VALUES (${farmA}::uuid, 'Bad-Key', ${featuresSql.json(1)}, 200)`,
    ),
    '23514',
  )
  await featuresSql`UPDATE farm.spool_library_settings SET value = ${featuresSql.json('USD')}, updated_at = 250 WHERE farm_id = ${farmA}::uuid AND key = 'currency'`
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_library_settings SET farm_id = ${farmB}::uuid WHERE farm_id = ${farmA}::uuid AND key = 'currency'`,
    ),
    '42501',
  )
  check('upstream-settings-api-and-constraints')

  // --- 2. custom field definitions (vendor/filament/spool) ------------------
  for (const entity of ['vendor', 'filament', 'spool']) {
    const [rowA] = await featuresSql`
      INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, sort_order, choices, multi_choice, updated_at)
      VALUES (${farmA}::uuid, ${entity}, 'shelf_code', 'Shelf Code', 'text', 1, NULL, false, 200)
      RETURNING source_key, source_sha256`
    assert.equal(rowA.source_key, 'local')
    assert.equal(rowA.source_sha256, '0'.repeat(64))
    await featuresSql`
      INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, sort_order, choices, multi_choice, updated_at)
      VALUES (${farmB}::uuid, ${entity}, 'shelf_code', 'Shelf Code', 'choice', 0, ${featuresSql.json(['A', 'B'])}, true, 200)`
  }
  await featuresSql`
    INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, sort_order, source_key, source_sha256, updated_at)
    VALUES (${farmA}::uuid, 'spool', 'imported_field', 'Imported', 'integer', 2, 'spoolman-1', ${sha('field')}, 200)`
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, updated_at) VALUES (${farmA}::uuid, 'printer', 'x', 'X', 'text', 200)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_library_fields (farm_id, entity_type, key, name, field_type, updated_at) VALUES (${farmA}::uuid, 'spool', 'shelf_code', 'Dup', 'text', 200)`,
    ),
    '23505',
  )
  check('custom-field-definitions-and-constraints')

  // --- 3. locations ---------------------------------------------------------
  await featuresSql`
    INSERT INTO farm.spool_locations (farm_id, name, sort_order, created_at, updated_at)
    VALUES (${farmA}::uuid, 'Shelf A', 1, 200, 200),
           (${farmB}::uuid, 'Shelf A', 1, 200, 200)`
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_locations (farm_id, name, created_at, updated_at) VALUES (${farmA}::uuid, ' Shelf A ', 200, 200)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_locations (farm_id, name, created_at, updated_at) VALUES (${farmA}::uuid, 'Bad Time', 300, 200)`,
    ),
    '23514',
  )
  await featuresSql`UPDATE farm.spool_locations SET name = 'Drybox 1', updated_at = 250 WHERE farm_id = ${farmA}::uuid AND name = 'Shelf A'`
  await featuresSql`UPDATE farm.spools SET location = 'Drybox 1' WHERE farm_id = ${farmA}::uuid AND id = 1`
  check('locations-and-rename')

  // --- 4. per-farm settings (currency + default threshold) & per-filament ---
  await featuresSql`
    INSERT INTO farm.spool_farm_settings (farm_id, default_low_stock_threshold_grams, currency, updated_at)
    VALUES (${farmA}::uuid, 150.0, 'EUR', 200),
           (${farmB}::uuid, NULL, 'USD', 200)`
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_farm_settings (farm_id, currency, updated_at) VALUES (${randomUUID()}::uuid, 'USD', 200)`,
    ),
    '23503',
  )
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_farm_settings SET currency = 'usd' WHERE farm_id = ${farmA}::uuid`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_farm_settings SET default_low_stock_threshold_grams = -5 WHERE farm_id = ${farmA}::uuid`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_farm_settings SET default_low_stock_threshold_grams = 'NaN'::float8 WHERE farm_id = ${farmA}::uuid`,
    ),
    '23514',
  )
  await featuresSql`UPDATE farm.spool_filaments SET low_stock_threshold_grams = 200.5 WHERE farm_id = ${farmA}::uuid AND id = 1`
  await librarySql`UPDATE farm.spool_filaments SET low_stock_threshold_grams = 175.0 WHERE farm_id = ${farmA}::uuid AND id = 1`
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_filaments SET low_stock_threshold_grams = -1 WHERE farm_id = ${farmA}::uuid AND id = 1`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_filaments SET low_stock_threshold_grams = 'Infinity'::float8 WHERE farm_id = ${farmA}::uuid AND id = 1`,
    ),
    '23514',
  )
  check('low-stock-thresholds-and-farm-currency')

  // --- 5. spool slot assignments (one active spool per slot + farm FKs) -----
  const slot1 = randomUUID()
  await featuresSql`
    INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at)
    VALUES (${farmA}::uuid, ${slot1}::uuid, 1, ${printerA}::uuid, 'ams', 0, 300)`
  // Second active spool in same slot rejected
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 2, ${printerA}::uuid, 'ams', 0, 310)`,
    ),
    '23505',
  )
  // Different slot kinds/indices succeed
  await featuresSql`
    INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at)
    VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 2, ${printerA}::uuid, 'ams', 1, 310),
           (${farmA}::uuid, ${randomUUID()}::uuid, 2, ${printerA}::uuid, 'printer', 0, 310),
           (${farmA}::uuid, ${randomUUID()}::uuid, 2, ${printerA}::uuid, 'toolhead', 0, 310)`
  // Unassigning allows a new active spool in the same slot
  await featuresSql`UPDATE farm.spool_slot_assignments SET unassigned_at = 350 WHERE farm_id = ${farmA}::uuid AND id = ${slot1}::uuid`
  await featuresSql`
    INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at)
    VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 2, ${printerA}::uuid, 'ams', 0, 360)`
  // Invalid slot_kind, slot_index, timestamps
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, ${printerA}::uuid, 'drybox', 0, 400)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at, unassigned_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, ${printerA}::uuid, 'ams', 2, 400, 399)`,
    ),
    '23514',
  )
  // Cross-farm FK rejection (farmA row pointing at farmB printer)
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_slot_assignments (farm_id, id, spool_id, printer_id, slot_kind, slot_index, assigned_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, ${printerB}::uuid, 'ams', 0, 400)`,
    ),
    '23503',
  )
  check('spool-slot-assignments-uniqueness-and-isolation')

  // --- 6. spool usage records + cost formula + cross-farm FKs ---------------
  const usage1 = randomUUID()
  const usage2 = randomUUID()
  await featuresSql`
    INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, job_id, printer_id, grams, source, created_at)
    VALUES (${farmA}::uuid, ${usage1}::uuid, 1, ${jobA}, ${printerA}::uuid, 100.0, 'telemetry', 500),
           (${farmA}::uuid, ${usage2}::uuid, 2, NULL, NULL, 50.0, 'manual', 510),
           (${farmA}::uuid, ${randomUUID()}::uuid, 1, NULL, NULL, 12.5, 'api', 520)`
  // Telemetry requires printer_id
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, job_id, printer_id, grams, source, created_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, NULL, NULL, 5.0, 'telemetry', 530)`,
    ),
    '23514',
  )
  // Negative / NaN / Infinity grams and invalid source rejected
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, grams, source, created_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, -1.0, 'manual', 530)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, grams, source, created_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, 'NaN'::float8, 'manual', 530)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, grams, source, created_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, 10.0, 'slicer', 530)`,
    ),
    '23514',
  )
  // Correction update works; immutable columns rejected
  await featuresSql`UPDATE farm.spool_usage_records SET grams = 80.0, corrected_by = 'acc-a' WHERE farm_id = ${farmA}::uuid AND id = ${usage1}::uuid`
  assert.equal(
    await sqlState(
      featuresSql`UPDATE farm.spool_usage_records SET source = 'manual' WHERE farm_id = ${farmA}::uuid AND id = ${usage1}::uuid`,
    ),
    '42501',
  )
  // Cross-farm FKs rejected (farmA usage pointing at farmB printer or job)
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, printer_id, grams, source, created_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, ${printerB}::uuid, 10.0, 'telemetry', 540)`,
    ),
    '23503',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_usage_records (farm_id, id, spool_id, job_id, printer_id, grams, source, created_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, ${jobB}, ${printerA}::uuid, 10.0, 'telemetry', 540)`,
    ),
    '23503',
  )
  // Cost per print = COALESCE(spool.price, filament.price) / initial_weight * grams
  const costs = await featuresSql`
    SELECT u.id,
           (COALESCE(s.price, f.price) / s.initial_weight) * u.grams AS cost,
           fs.currency
    FROM farm.spool_usage_records u
    JOIN farm.spools s ON s.farm_id = u.farm_id AND s.id = u.spool_id
    JOIN farm.spool_filaments f ON f.farm_id = s.farm_id AND f.id = s.filament_id
    JOIN farm.spool_farm_settings fs ON fs.farm_id = u.farm_id
    WHERE u.farm_id = ${farmA}::uuid AND u.id IN (${usage1}::uuid, ${usage2}::uuid)
    ORDER BY u.created_at`
  assert.equal(costs.length, 2)
  // spool 1 price = 25, initial_weight = 1000, corrected grams = 80 -> 2.00 EUR
  assert.equal(costs[0].cost, 2)
  assert.equal(costs[0].currency, 'EUR')
  // spool 2 price = NULL (fallback filament price = 30), initial_weight = 1000, grams = 50 -> 1.50 EUR
  assert.equal(costs[1].cost, 1.5)
  assert.equal(costs[1].currency, 'EUR')
  check('spool-usage-records-cost-and-isolation')

  // --- 7. drying log --------------------------------------------------------
  const dry1 = randomUUID()
  await featuresSql`
    INSERT INTO farm.spool_drying_logs (farm_id, id, spool_id, started_at, temperature_celsius, notes)
    VALUES (${farmA}::uuid, ${dry1}::uuid, 1, 600, 55.0, '4h PETG dry')`
  await featuresSql`UPDATE farm.spool_drying_logs SET ended_at = 660, notes = 'Completed' WHERE farm_id = ${farmA}::uuid AND id = ${dry1}::uuid`
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_drying_logs (farm_id, id, spool_id, started_at, ended_at, temperature_celsius) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, 700, 699, 55.0)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_drying_logs (farm_id, id, spool_id, started_at, temperature_celsius) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, 700, 350.0)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_drying_logs (farm_id, id, spool_id, started_at, temperature_celsius) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 999, 700, 55.0)`,
    ),
    '23503',
  )
  check('drying-logs-constraints-and-isolation')

  // --- 8. humidity readings (spool or slot or both) -------------------------
  await featuresSql`
    INSERT INTO farm.spool_humidity_readings (farm_id, id, spool_id, printer_id, slot_kind, slot_index, humidity_percent, source, recorded_at)
    VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, NULL, NULL, NULL, 24.5, 'manual', 700),
           (${farmA}::uuid, ${randomUUID()}::uuid, NULL, ${printerA}::uuid, 'ams', 0, 18.0, 'ams', 710),
           (${farmA}::uuid, ${randomUUID()}::uuid, 1, ${printerA}::uuid, 'ams', 0, 19.2, 'ams', 720)`
  // Neither spool nor slot rejected
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_humidity_readings (farm_id, id, humidity_percent, source, recorded_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 20.0, 'manual', 730)`,
    ),
    '23514',
  )
  // Partial slot rejected
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_humidity_readings (farm_id, id, printer_id, slot_kind, humidity_percent, source, recorded_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, ${printerA}::uuid, 'ams', 20.0, 'ams', 730)`,
    ),
    '23514',
  )
  // Out-of-range humidity or bad source rejected
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_humidity_readings (farm_id, id, spool_id, humidity_percent, source, recorded_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, 101.0, 'manual', 730)`,
    ),
    '23514',
  )
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_humidity_readings (farm_id, id, spool_id, humidity_percent, source, recorded_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, 1, 25.0, 'sensor', 730)`,
    ),
    '23514',
  )
  // Cross-farm FK rejection (farmA reading pointing at farmB printer)
  assert.equal(
    await sqlState(
      featuresSql`INSERT INTO farm.spool_humidity_readings (farm_id, id, printer_id, slot_kind, slot_index, humidity_percent, source, recorded_at) VALUES (${farmA}::uuid, ${randomUUID()}::uuid, ${printerB}::uuid, 'ams', 0, 20.0, 'ams', 730)`,
    ),
    '23503',
  )
  check('humidity-readings-constraints-and-isolation')

  // --- 9. down migration (with rows present) and up->down round trip --------
  await featuresSql.end({ timeout: 3 })
  featuresSql = undefined
  await admin`DROP ROLE ${admin(loginRoles.pop())}`

  await runMigrations(admin, catalog, {
    kind: 'down',
    expectedLastId: MIGRATION,
  })
  assert.equal(await countNewTables(), 0)
  assert.equal(await hasThresholdColumn(), 0)
  assert.equal(await hasFeaturesRole(), 0)
  // Existing settings and fields rows survive 0089 rollback untouched
  const survivingSetting =
    await admin`SELECT key FROM farm.spool_library_settings WHERE farm_id = ${farmA}::uuid ORDER BY key`
  assert.deepEqual(
    survivingSetting.map((r) => r.key),
    ['currency', 'imported_key'],
  )
  const survivingField =
    await admin`SELECT key FROM farm.spool_library_fields WHERE farm_id = ${farmA}::uuid AND entity_type = 'spool' ORDER BY key`
  assert.deepEqual(
    survivingField.map((r) => r.key),
    ['imported_field', 'shelf_code'],
  )
  // Defaults removed on down
  assert.equal(
    await sqlState(
      admin`INSERT INTO farm.spool_library_settings (farm_id, key, value, updated_at) VALUES (${farmA}::uuid, 'no_default', ${admin.json(1)}, 900)`,
    ),
    '23502',
  )
  // Existing roles still valid after 0089 down
  await validateSpoolLibraryRole(librarySql)
  await validateSpoolImportRole(importSql)
  check('migration-0089-down-with-data-and-provenance-preserved')

  // Re-apply up and roll back down cleanly
  await runMigrations(admin, catalog, { kind: 'up' })
  assert.equal(await countNewTables(), NEW_TABLES.length)
  assert.equal(await hasThresholdColumn(), 1)
  assert.equal(await hasFeaturesRole(), 1)
  await runMigrations(admin, catalog, {
    kind: 'down',
    expectedLastId: MIGRATION,
  })
  assert.equal(await countNewTables(), 0)
  assert.equal(await hasFeaturesRole(), 0)
  check('migration-0089-up-down-clean-round-trip')

  console.log(
    JSON.stringify(
      { ok: true, container: containerName, image, evidenceDir, checks },
      null,
      2,
    ),
  )
} catch (error) {
  process.exitCode = 1
  const text =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  await writeFile(
    join(evidenceDir, 'failure.json'),
    JSON.stringify({ error: text.slice(0, 32768), checks }, null, 2),
    { mode: 0o600 },
  ).catch(() => {})
  console.error(`FAILED after ${checks.length} checks: ${text.slice(0, 4000)}`)
  console.error(`Diagnostics retained in ${evidenceDir}`)
} finally {
  await featuresSql?.end({ timeout: 3 }).catch(() => {})
  await librarySql?.end({ timeout: 3 }).catch(() => {})
  await importSql?.end({ timeout: 3 }).catch(() => {})
  try {
    await fixture.stop()
  } catch (error) {
    console.error(
      `Container removal reported: ${String(error).split('\n', 1)[0]}`,
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
