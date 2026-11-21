// Inventory, job-history and sandbox job submit against a migrated disposable database.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import postgres from 'postgres'
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
  console.log(JSON.stringify({ result: 'passed', checks }))
} finally {
  if (owned) await owned.stop()
  else await sql?.end({ timeout: 3 })
}
