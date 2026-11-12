// Explicit test-only runner. Never accepts a database URL, existing container,
// hardware mount or inherited PostgreSQL connection settings.
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

const exec = promisify(execFile)
const image = process.env.RENEWAL_TEST_IMAGE
if (
  process.argv.length !== 2 ||
  process.env.RENEWAL_TEST_ADMITTED !== 'yes' ||
  !image ||
  !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(image)
)
  throw new Error(
    'Fresh test admission and locally available digest-pinned PostgreSQL 17 image required',
  )
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
const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()
const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
const baseline = {
  disk: await statfs(process.cwd(), { bigint: true }).then((x) => ({
    availableBytes: String(x.bavail * x.bsize),
  })),
  gitStatus: (await exec('git', ['status', '--porcelain'])).stdout,
  worktrees: (await exec('git', ['worktree', 'list', '--porcelain'])).stdout,
  containers: await docker('ps', '-a', '--format', '{{.ID}} {{.Names}}'),
  images: await docker('image', 'ls', '--no-trunc', '--format', '{{.ID}}'),
  volumes: await docker('volume', 'ls', '--format', '{{.Name}}'),
  networks: await docker('network', 'ls', '--format', '{{.ID}} {{.Name}}'),
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
// Fails rather than pulling: image ownership and deletion remain with its owner.
await docker('image', 'inspect', image)
const imageVolumes: unknown = JSON.parse(
  await docker(
    'image',
    'inspect',
    '--format',
    '{{json .Config.Volumes}}',
    image,
  ),
)
assert.ok(
  imageVolumes === null ||
    (typeof imageVolumes === 'object' &&
      Object.keys(imageVolumes).every(
        (path) => path === '/var/lib/postgresql/data',
      )),
  'Image volumes must be covered by the task-owned tmpfs; no anonymous volumes allowed',
)
let container: string | undefined
let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
try {
  // Record intent before allocation, so interrupted startup has an exact name.
  await writeFile(
    join(evidence, 'ownership.json'),
    JSON.stringify({
      id,
      name,
      label,
      image,
      reason:
        'Fresh isolated cluster is required: migrations create cluster-wide roles',
      volumes: [],
      networksCreated: [],
      imagePulled: false,
    }),
    { mode: 0o600 },
  )
  await docker(
    'create',
    '--name',
    name,
    '--label',
    label,
    '--pull',
    'never',
    '--cpus',
    '4',
    '--memory',
    '8g',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    'postgres',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,mode=1777',
    '--tmpfs',
    '/var/run/postgresql:rw,mode=1777',
    '--tmpfs',
    '/tmp:rw,mode=1777',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_USER=fixture',
    '-e',
    'POSTGRES_DB=fixture',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    // A child directory lets the image's postgres UID own PGDATA without
    // assuming Debian/Alpine UID values or chmodding a root-owned tmpfs.
    'PGDATA=/var/lib/postgresql/data/pgdata',
    image,
  )
  container = await docker('inspect', '--format', '{{.Id}}', name)
  assert.match(container, /^[a-f0-9]{64}$/)
  assert.equal(
    await docker(
      'inspect',
      '--format',
      '{{index .Config.Labels "org.open3dfarmmanager.renewal-test"}}',
      container,
    ),
    id,
  )
  await writeFile(join(evidence, 'container-id.txt'), container + '\n', {
    mode: 0o600,
  })
  await docker('start', container)
  // Bounded startup readiness inside the owned container, never a shared server.
  await docker(
    'exec',
    container,
    'sh',
    '-c',
    'n=0; until pg_isready -U fixture -d fixture >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
  )
  const mapping = await docker('port', container, '5432/tcp')
  assert.match(mapping, /^127\.0\.0\.1:[0-9]+$/)
  const port = Number(mapping.split(':')[1])
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535)
  sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: 'fixture',
    password: '',
    ssl: false,
    max: 8,
    connect_timeout: 3,
    connection: {
      application_name: name,
      statement_timeout: 10000,
      lock_timeout: 5000,
    },
  })
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
  assert.match(version, /^17\./)
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
    JSON.stringify({ version, image, journal }, null, 2),
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
  if (container) {
    const logs = await docker('logs', '--tail', '200', container).catch(
      (error) => String(error),
    )
    await writeFile(join(evidence, 'postgres.log'), logs, { mode: 0o600 })
  }
} finally {
  try {
    await sql?.end({ timeout: 3 })
  } catch (error) {
    cleanupFailure = error
  }
  try {
    // Recover exact ownership if create completed but ID recording was interrupted.
    const owned =
      container ??
      (await docker('inspect', '--format', '{{.Id}}', name).catch(() => ''))
    if (owned) {
      assert.match(owned, /^[a-f0-9]{64}$/)
      assert.equal(
        await docker(
          'inspect',
          '--format',
          '{{index .Config.Labels "org.open3dfarmmanager.renewal-test"}}',
          owned,
        ),
        id,
      )
      assert.equal(
        await docker('inspect', '--format', '{{.Name}}', owned),
        '/' + name,
      )
      await docker('stop', '--time', '3', owned)
      await docker('rm', owned)
      assert.equal(
        await docker(
          'ps',
          '-a',
          '--filter',
          'id=' + owned,
          '--format',
          '{{.ID}}',
        ),
        '',
        'exact owned container must be absent',
      )
    }
  } catch (error) {
    cleanupFailure ??= error
  }
  await writeFile(
    join(evidence, 'cleanup.json'),
    JSON.stringify(
      {
        container,
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
