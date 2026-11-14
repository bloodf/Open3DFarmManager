// Explicit test-only runner: signalling with renewed (successor) Connector
// credentials on a fresh, task-owned, digest-pinned PostgreSQL 17 container.
// Never accepts a database URL or an existing container; never pulls an image.
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

const exec = promisify(execFile)
const image = process.env.SIGNALLING_SUCCESSOR_TEST_IMAGE
const prefix =
  process.env.SIGNALLING_SUCCESSOR_TEST_NAME_PREFIX ?? 'o3dfm-signal-successor'
if (
  process.argv.length !== 2 ||
  process.env.SIGNALLING_SUCCESSOR_TEST_ADMITTED !== 'yes' ||
  !image ||
  !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(
    image,
  ) ||
  !/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix)
)
  throw new Error(
    'SIGNALLING_SUCCESSOR_TEST_ADMITTED=yes and a locally available digest-pinned PostgreSQL 17 SIGNALLING_SUCCESSOR_TEST_IMAGE are required',
  )
const id = randomUUID()
const name = prefix + '-' + id
const labelKey = 'org.open3dfarmmanager.signalling-successor-test'
const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()
let container: string | undefined
let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
let checks: string[] = []
try {
  // Fails rather than pulling: image ownership remains with its owner.
  await docker('image', 'inspect', image)
  await docker(
    ...['create', '--name', name, '--label', `${labelKey}=${id}`],
    ...['--pull', 'never', '--cpus', '2', '--memory', '2g', '--read-only'],
    ...['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'],
    ...[
      '--user',
      'postgres',
      '--tmpfs',
      '/var/lib/postgresql/data:rw,mode=1777',
    ],
    ...['--tmpfs', '/var/run/postgresql:rw,mode=1777'],
    ...['--tmpfs', '/tmp:rw,mode=1777', '-p', '127.0.0.1::5432'],
    ...['-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture'],
    ...['-e', 'POSTGRES_HOST_AUTH_METHOD=trust'],
    ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
    image,
  )
  container = await docker('inspect', '--format', '{{.Id}}', name)
  assert.match(container, /^[a-f0-9]{64}$/)
  await docker('start', container)
  await docker(
    ...['exec', container, 'sh', '-c'],
    'n=0; until pg_isready -U fixture -d fixture >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
  )
  const mapping = await docker('port', container, '5432/tcp')
  assert.match(mapping, /^127\.0\.0\.1:[0-9]+$/)
  const port = Number(mapping.split(':')[1])
  sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: 'fixture',
    password: '',
    ssl: false,
    max: 4,
    connect_timeout: 3,
    connection: { application_name: name, statement_timeout: 10000 },
  })
  assert.equal(
    (await sql`SELECT to_regnamespace('farm') AS n`)[0]?.n,
    null,
    'fresh task-owned cluster only',
  )
  assert.match((await sql`SHOW server_version`)[0]?.server_version, /^17\./)
  const full = await loadMigrationCatalog()
  catalogThrough(full, '0026_signalling_successor_credentials')
  await runMigrations(sql, full, { kind: 'up' })
  const journal = async () => [
    ...(await sql!`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`),
  ]
  assert.equal(validateMigrationHistory(full, await journal()), full.length)
  checks = await testPostgresSignallingSuccessors(sql, port)
  // 0026 is reversible and only removes its own grants.
  if (full.at(-1)?.id === '0026_signalling_successor_credentials') {
    await runMigrations(sql, full, {
      kind: 'down',
      expectedLastId: '0026_signalling_successor_credentials',
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
    const owned =
      container ??
      (await docker('inspect', '--format', '{{.Id}}', name).catch(() => ''))
    if (owned) {
      assert.equal(
        await docker(
          'inspect',
          '--format',
          `{{index .Config.Labels "${labelKey}"}}`,
          owned,
        ),
        id,
      )
      await docker('rm', '--force', owned)
    }
  } catch (error) {
    cleanupFailure ??= error
  }
}
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
