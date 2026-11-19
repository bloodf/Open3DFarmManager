// Explicit test-only runner: signalling with renewed (successor) Connector
// credentials on a fresh, task-owned disposable PostgreSQL cluster.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresSignallingSuccessors } from '../tests/helpers/postgres-signalling-successors-integration.ts'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  type DockerCommand,
} from '../tests/helpers/disposable-postgres.ts'

const exec = promisify(execFile)
const isDocker = process.env.OPENFARM_PG === 'docker'
const image = process.env.SIGNALLING_SUCCESSOR_TEST_IMAGE
const prefix =
  process.env.SIGNALLING_SUCCESSOR_TEST_NAME_PREFIX ?? 'o3dfm-signal-successor'
if (
  process.argv.length !== 2 ||
  process.env.SIGNALLING_SUCCESSOR_TEST_ADMITTED !== 'yes' ||
  (isDocker && (!image || !POSTGRES_IMAGE_PATTERN.test(image))) ||
  !/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix)
)
  throw new Error(
    'SIGNALLING_SUCCESSOR_TEST_ADMITTED=yes and a valid test prefix required',
  )
const id = randomUUID()
const name = prefix + '-' + id
const labelKey = 'org.open3dfarmmanager.signalling-successor-test'

let dockerCmd: DockerCommand | undefined
if (isDocker) {
  dockerCmd = async (...args: string[]) =>
    (
      await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
    ).stdout.trim()
}

const database = disposablePostgres({
  name,
  labelKey,
  labelValue: id,
  port: 0,
  through: false,
  ...(isDocker ? { docker: dockerCmd, image } : {}),
})

let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
let checks: string[] = []
try {
  sql = await database.start()
  const port = database.port

  assert.equal(
    (await sql`SELECT to_regnamespace('farm') AS n`)[0]?.n,
    null,
    'fresh task-owned cluster only',
  )
  const full = await loadMigrationCatalog()
  catalogThrough(full, '0030_signalling_successor_credentials')
  await runMigrations(sql, full, { kind: 'up' })
  const journal = async () => [
    ...(await sql!`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`),
  ]
  assert.equal(validateMigrationHistory(full, await journal()), full.length)
  checks = await testPostgresSignallingSuccessors(sql, port)
  // 0026 is reversible and only removes its own grants.
  if (full.at(-1)?.id === '0030_signalling_successor_credentials') {
    await runMigrations(sql, full, {
      kind: 'down',
      expectedLastId: '0030_signalling_successor_credentials',
    })
    const granted = async (role: string) =>
      (
        await sql!`SELECT has_table_privilege(${role},'farm.connector_credential_successors','SELECT') AS allowed`
      )[0]?.allowed
    assert.equal(await granted('farm_signalling_reader'), false)
    assert.equal(await granted('farm_connector_credential_acceptor'), false)
    assert.equal(await granted('farm_connector_telemetry_writer'), true)
    await runMigrations(sql, full, { kind: 'up' })
    assert.equal(validateMigrationHistory(full, await journal()), full.length)
    checks.push(
      '0026 down removes only its grants (telemetry writer keeps 0022) and re-applies',
    )
  }
  console.log(JSON.stringify({ result: 'passed', checks }))
} catch (error) {
  failure = error
} finally {
  try {
    await sql?.end({ timeout: 3 })
  } catch (error) {
    cleanupFailure ??= error
  }
  try {
    await database.stop()
  } catch (error) {
    cleanupFailure ??= error
  }
}
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
