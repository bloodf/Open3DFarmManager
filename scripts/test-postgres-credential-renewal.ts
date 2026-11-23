// Explicit test-only runner. Never accepts an inherited PostgreSQL connection setting.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { testPostgresCredentialRenewal } from '../tests/helpers/postgres-credential-renewal-integration.ts'
import { testRenewalHttps } from '../tests/helpers/renewal-https-integration.ts'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  type DockerCommand,
} from '../tests/helpers/disposable-postgres.ts'

const exec = promisify(execFile)
const isDocker = process.env.OPENFARM_PG === 'docker'
const image = process.env.RENEWAL_TEST_IMAGE
if (
  process.argv.length !== 2 ||
  process.env.RENEWAL_TEST_ADMITTED !== 'yes' ||
  (isDocker && (!image || !POSTGRES_IMAGE_PATTERN.test(image)))
)
  throw new Error('Fresh test admission required')
// Optional built-server phase: "<appPort>,<proxyPort>" on loopback; needs apps/farm/.output.
const httpsPorts = process.env.RENEWAL_TEST_HTTPS_PORTS?.split(',').map(Number)
if (
  httpsPorts &&
  (httpsPorts.length !== 2 ||
    httpsPorts.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535))
)
  throw new Error('Invalid built-server port pair')
const id = randomUUID()
// Optional caller-owned name prefix so parallel runners can audit their own resources.
const prefix = process.env.RENEWAL_TEST_NAME_PREFIX ?? 'o3dfm-renewals'
if (!/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix))
  throw new Error('Invalid renewal test name prefix')
const name = prefix + '-' + id
const label = 'org.open3dfarmmanager.renewal-test=' + id
const evidence = join(
  homedir(),
  '.local/state/o3dfm/credential-renewal-tests',
  id,
)
await mkdir(evidence, { recursive: true, mode: 0o700 })

let dockerCmd: DockerCommand | undefined
if (isDocker) {
  dockerCmd = async (...args: string[]) =>
    (
      await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
    ).stdout.trim()
  const endpoint =
    process.env.DOCKER_HOST ??
    (await dockerCmd(
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ))
  assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
}

const baseline = {
  disk: await statfs(process.cwd(), { bigint: true }).then((x) => ({
    availableBytes: String(x.bavail * x.bsize),
  })),
  gitStatus: (await exec('git', ['status', '--porcelain'])).stdout,
  worktrees: (await exec('git', ['worktree', 'list', '--porcelain'])).stdout,
  ...(isDocker && dockerCmd
    ? {
        containers: await dockerCmd(
          'ps',
          '-a',
          '--format',
          '{{.ID}} {{.Names}}',
        ),
        images: await dockerCmd(
          'image',
          'ls',
          '--no-trunc',
          '--format',
          '{{.ID}}',
        ),
        volumes: await dockerCmd('volume', 'ls', '--format', '{{.Name}}'),
        networks: await dockerCmd(
          'network',
          'ls',
          '--format',
          '{{.ID}} {{.Name}}',
        ),
      }
    : {}),
}
await writeFile(
  join(evidence, 'baseline.json'),
  JSON.stringify(baseline, null, 2),
  { mode: 0o600 },
)
assert.ok(
  BigInt(baseline.disk.availableBytes) >= 2n * 1024n ** 3n,
  'At least 2 GiB free required; no pull is performed',
)

await writeFile(
  join(evidence, 'ownership.json'),
  JSON.stringify({
    id,
    name,
    label,
    image: image ?? null,
    reason:
      'Fresh isolated cluster is required: migrations create cluster-wide roles',
    volumes: [],
    networksCreated: [],
    imagePulled: false,
  }),
  { mode: 0o600 },
)

const database = disposablePostgres({
  name,
  labelKey: 'org.open3dfarmmanager.renewal-test',
  labelValue: id,
  port: 0,
  through: false,
  ...(isDocker ? { docker: dockerCmd, image } : {}),
})

let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
try {
  sql = await database.start()
  const port = database.port

  const identity = (
    await sql`SELECT current_database() AS db,current_user AS actor`
  )[0]
  assert.equal(identity?.db, 'fixture')
  assert.equal(identity?.actor, 'fixture')
  assert.equal(
    (await sql`SELECT to_regnamespace('farm') AS n`)[0]?.n,
    null,
    'fresh task-owned cluster only',
  )
  const version = (await sql`SHOW server_version`)[0]?.server_version
  const major = parseInt(version ?? '', 10)
  assert.ok(
    !Number.isNaN(major) && major >= 13,
    'PostgreSQL version >= 13 required',
  )

  const catalog = catalogThrough(
    await loadMigrationCatalog(),
    '0023_connector_credential_renewals',
  )
  await runMigrations(sql, catalog, { kind: 'up' })
  const journal =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...journal]), catalog.length)
  await writeFile(
    join(evidence, 'journal.json'),
    JSON.stringify({ version, image: image ?? null, journal }, null, 2),
  )
  const dependency = 'renewal_dependency_' + id.replaceAll('-', '')
  await sql`CREATE TABLE public.${sql(dependency)}(root_jti uuid,kind text,jti uuid,FOREIGN KEY(root_jti,kind,jti) REFERENCES farm.connector_credential_renewals(root_jti,predecessor_kind,predecessor_jti))`
  const migration = catalog.at(-1)
  if (!migration) throw new Error('Missing renewal migration')
  try {
    await assert.rejects(
      sql.begin((tx) => tx.unsafe(migration.down).simple()),
      /depend/,
    )
  } finally {
    await sql`DROP TABLE public.${sql(dependency)}`
  }
  const checks = await testPostgresCredentialRenewal(
    sql,
    port,
    join(evidence, 'child-resources.jsonl'),
  )
  if (httpsPorts)
    checks.push(
      ...(await testRenewalHttps(sql, port, {
        app: httpsPorts[0]!,
        proxy: httpsPorts[1]!,
      })),
    )
  const last = catalog.at(-1)
  if (!last) throw new Error('Missing migration')
  await assert.rejects(
    sql.begin((tx) => tx.unsafe(last.down).simple()),
    /Retain renewal operations and receipts/,
  )
  checks.push(
    'official0023 down refuses dependent objects and retained operation data',
  )
  await writeFile(
    join(evidence, 'checks.json'),
    JSON.stringify({ result: 'passed', checks }, null, 2),
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ result: 'passed', checks, evidence }))
} catch (error) {
  failure = error
  await writeFile(
    join(evidence, 'first-failure.txt'),
    (error instanceof Error ? error.stack : String(error)) + '\n',
    {
      mode: 0o600,
    },
  )
} finally {
  try {
    await sql?.end({ timeout: 3 })
  } catch (error) {
    cleanupFailure = error
  }
  try {
    await database.stop()
  } catch (error) {
    cleanupFailure ??= error
  }
  await writeFile(
    join(evidence, 'cleanup.json'),
    JSON.stringify(
      {
        name,
        removed: !cleanupFailure,
        retained:
          'Bounded evidence only; pre-existing images, networks, volumes, worktrees untouched',
        error: cleanupFailure ? String(cleanupFailure) : null,
        diskAvailableBytes: await statfs(process.cwd(), { bigint: true }).then(
          (x) => String(x.bavail * x.bsize),
        ),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
