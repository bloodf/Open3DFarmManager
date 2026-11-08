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
import { testPostgresCredentialSuccessors } from '../tests/helpers/postgres-credential-successors-integration.ts'

const exec = promisify(execFile)
const image = process.env.SUCCESSOR_TEST_IMAGE
if (
  process.argv.length !== 2 ||
  process.env.SUCCESSOR_TEST_ADMITTED !== 'yes' ||
  !image ||
  !/^postgres:18(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(image)
)
  throw new Error(
    'Fresh test admission and locally available digest-pinned PostgreSQL 18 image required',
  )
const id = randomUUID()
const name = 'o3dfm-successors-' + id
const label = 'org.open3dfarmmanager.successor-test=' + id
const evidence = join(
  homedir(),
  '.local/state/o3dfm/credential-successor-tests',
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
        (path) => path === '/var/lib/postgresql',
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
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    'postgres',
    '--tmpfs',
    '/var/lib/postgresql:rw,mode=1777',
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
    'PGDATA=/var/lib/postgresql/data',
    image,
  )
  container = await docker('inspect', '--format', '{{.Id}}', name)
  assert.match(container, /^[a-f0-9]{64}$/)
  assert.equal(
    await docker(
      'inspect',
      '--format',
      '{{index .Config.Labels "org.open3dfarmmanager.successor-test"}}',
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
  const checks = await testPostgresCredentialSuccessors(sql, port)
  await writeFile(
    join(evidence, 'checks.json'),
    JSON.stringify({ result: 'passed', checks }, null, 2),
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ result: 'passed', checks, evidence }))
} catch (error) {
  failure = error
  await writeFile(join(evidence, 'first-failure.txt'), String(error) + '\n', {
    mode: 0o600,
  })
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
          '{{index .Config.Labels "org.open3dfarmmanager.successor-test"}}',
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
