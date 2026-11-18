// Explicit test-only runner. Never accepts an inherited PostgreSQL connection setting.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { testPostgresCredentialSuccessors } from '../tests/helpers/postgres-credential-successors-integration.ts'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  type DockerCommand,
} from '../tests/helpers/disposable-postgres.ts'

const exec = promisify(execFile)
const isDocker = process.env.OPENFARM_PG === 'docker'
const image = process.env.SUCCESSOR_TEST_IMAGE
if (
  process.argv.length !== 2 ||
  process.env.SUCCESSOR_TEST_ADMITTED !== 'yes' ||
  (isDocker && (!image || !POSTGRES_IMAGE_PATTERN.test(image)))
)
  throw new Error('Fresh test admission required')
const id = randomUUID()
const name = 'o3dfm-successors-' + id
const label = 'org.open3dfarmmanager.successor-test=' + id
const evidence = join(
  homedir(),
  '.local/state/o3dfm/credential-successor-tests',
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
  'At least 2 GiB free required',
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
  labelKey: 'org.open3dfarmmanager.successor-test',
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
