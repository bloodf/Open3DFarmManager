// Inventory, job-history and sandbox job submit against a migrated disposable database.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import postgres, { type Sql } from 'postgres'
import {
  listIntegrationSpoolUsage,
  searchIntegrationSpools,
} from '../apps/farm/server/utils/integration-inventory-ledger.ts'
import { postgresResinReader } from '../apps/farm/server/utils/integration-resin-postgres.ts'
import { recordJobs } from '../apps/farm/server/storage/job-history-store.ts'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  type DockerCommand,
} from '../tests/helpers/disposable-postgres.ts'
import { testPostgresIntegrationRead } from '../tests/helpers/postgres-integration-read.ts'

const exec = promisify(execFile)
const portText = process.env.INTEGRATION_READ_SYNTHETIC_TEST_PORT
const admitted = process.env.INTEGRATION_READ_SYNTHETIC_TEST_DISPOSABLE
const useOwnedFixture = portText === undefined && admitted === undefined
const port = Number(portText)
if (
  !useOwnedFixture &&
  (admitted !== 'yes' ||
    !portText ||
    !/^\d{4,5}$/.test(portText) ||
    port < 1024 ||
    port > 65535)
)
  throw new Error('Explicit disposable loopback PostgreSQL fixture required')

async function pinnedPostgres17(docker: DockerCommand) {
  const fromEnv = process.env.POSTGRES_TEST_IMAGE
  if (fromEnv) {
    if (!POSTGRES_IMAGE_PATTERN.test(fromEnv))
      throw new Error('POSTGRES_TEST_IMAGE must be a digest-pinned postgres:17')
    return fromEnv
  }
  try {
    const digest = (
      await docker(
        'image',
        'inspect',
        'postgres:17',
        '--format',
        '{{index .RepoDigests 0}}',
      )
    ).replace(/^postgres@/, 'postgres:17@')
    if (POSTGRES_IMAGE_PATTERN.test(digest)) return digest
  } catch {
    // The tag is optional when a digest-pinned postgres 17 image is already local.
  }
  const listed = await docker(
    'image',
    'ls',
    '--digests',
    '--no-trunc',
    '--format',
    '{{.Repository}} {{.Digest}}',
  )
  for (const line of listed.split('\n')) {
    const [repository, digest] = line.trim().split(/\s+/)
    if (repository !== 'postgres' || !digest?.startsWith('sha256:')) continue
    const image = `postgres:17@${digest}`
    if (!POSTGRES_IMAGE_PATTERN.test(image)) continue
    const major = await docker(
      'image',
      'inspect',
      image,
      '--format',
      '{{range .Config.Env}}{{println .}}{{end}}',
    )
    if (major.split('\n').includes('PG_MAJOR=17')) return image
  }
  throw new Error(
    'OPENFARM_PG=docker needs a local digest-pinned postgres:17 image',
  )
}

const isDocker = process.env.OPENFARM_PG === 'docker'
let docker: DockerCommand | undefined
let image: string | undefined
if (useOwnedFixture && isDocker) {
  docker = async (...args) =>
    (
      await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
    ).stdout.trim()
  const endpoint =
    process.env.DOCKER_HOST ??
    (await docker(
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ))
  assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
  image = await pinnedPostgres17(docker)
}

const owned = useOwnedFixture
  ? disposablePostgres({
      name: `o3dfm-integration-read-${randomUUID()}`,
      isolated: true,
      ...(docker && image ? { docker, image } : {}),
    })
  : undefined

let sql: ReturnType<typeof postgres> | undefined
try {
  sql = owned
    ? await owned.start()
    : postgres({
        host: '127.0.0.1',
        port,
        database: 'fixture',
        username: 'fixture',
        ssl: false,
        max: 4,
        connect_timeout: 3,
      })
  const checks = await testPostgresIntegrationRead(sql)
  const resinFarm = randomUUID()
  const resinAgent = randomUUID()
  const resinPrinter = randomUUID()
  const owner = `resin_${randomUUID().replaceAll('-', '')}`
  await sql`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${resinFarm}::uuid, true)`
  await sql`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${resinAgent}::uuid, ${resinFarm}::uuid, ${'k'.repeat(59)}, ${randomUUID().padEnd(50, 'f')})`
  await sql`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${resinAgent}::uuid`
  await sql`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${resinPrinter}::uuid, ${resinFarm}::uuid, ${resinAgent}::uuid, 'resin', 1, ${owner})`
  await sql`INSERT INTO farm.resin_ledger_entries (farm_id, id, printer_id, kind, name, source, recorded_at) VALUES (${resinFarm}::uuid, ${randomUUID()}::uuid, ${resinPrinter}::uuid, 'vat', 'fixture', 'reported', 123)`
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE farm_integration_apps`
    const ledgers = await postgresResinReader(tx as unknown as Sql).readLedgers(
      { farmWideFarmIds: [resinFarm], assignmentIds: [], limit: 10 },
    )
    assert.equal(ledgers.length, 1)
    assert.equal(ledgers[0]?.records.length, 1)
    const privilege =
      await tx`SELECT has_column_privilege(current_user, 'farm.resin_ledger_entries', 'recorded_by', 'SELECT') AS allowed`
    assert.equal(privilege[0]?.allowed, false)
  })
  checks.push(
    'integration role reads resin ledger without access to recorded_by',
  )
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE farm_integration_apps`
    const pool = tx as unknown as Sql
    const search = await searchIntegrationSpools(pool, [resinFarm], {
      farmId: resinFarm,
      limit: 10,
      color: null,
      material: null,
      availability: 'any',
      minRemainingGrams: null,
    })
    assert.equal(search.data.length, 0)
    const usage = await listIntegrationSpoolUsage(pool, [resinFarm], {
      farmId: resinFarm,
      limit: 10,
      jobId: '1',
      cursor: null,
    })
    assert.equal(usage.data.length, 0)
    const privileges = await tx`SELECT
      has_column_privilege(current_user, 'farm.spool_usage_records', 'grams', 'UPDATE') AS can_update,
      has_column_privilege(current_user, 'farm.spool_usage_records', 'corrected_by', 'SELECT') AS can_read_correction`
    assert.equal(privileges[0]?.can_update, false)
    assert.equal(privileges[0]?.can_read_correction, true)
  })
  checks.push(
    'integration role can read spool search and usage without write access',
  )
  const farmId = randomUUID()
  const agentId = randomUUID()
  const usage = [{ tool: 'extruder', grams: 12.5 }]
  await sql`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}::uuid, true)`
  await sql.begin(async (tx) => {
    await recordJobs(tx, { farmId, agentId }, [
      {
        printerKey: 'synthetic',
        outcome: 'completed',
        endedAt: 123,
        filamentUsage: usage,
      },
    ])
  })
  const rows =
    await sql`SELECT filament_usage, jsonb_typeof(filament_usage) AS kind FROM farm.job_history WHERE farm_id=${farmId}::uuid`
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.kind, 'array')
  assert.deepEqual(rows[0]?.filament_usage, usage)
  checks.push('job history stores filament usage as a JSON array')
  console.log(JSON.stringify({ result: 'passed', checks }))
} finally {
  if (owned) await owned.stop()
  else await sql?.end({ timeout: 3 })
}
