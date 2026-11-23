// Usage per job and printer, low stock, cost per print and inventory reports (#543).
// Starts one disposable PostgreSQL 17 Docker container (digest-pinned local image,
// loopback port), applies all migrations, runs tests/integration/spool-usage/**
// with a login that is a member of the least-privilege roles the feature needs,
// and removes the container.
//
//   node scripts/test-spool-usage.mjs
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  disposablePostgres,
  POSTGRES_IMAGE_PATTERN,
} from '../tests/helpers/disposable-postgres.ts'

const exec = promisify(execFile)
const docker = async (...args) =>
  (await exec('docker', args, { timeout: 300000 })).stdout.trim()
const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//)
const image = (
  process.env.SPOOL_LIBRARY_TEST_IMAGE ??
  (await docker(
    'image',
    'inspect',
    'postgres:17',
    '--format',
    '{{index .RepoDigests 0}}',
  ))
).replace(/^postgres@/, 'postgres:17@')
assert.match(image, POSTGRES_IMAGE_PATTERN)
process.env.OPENFARM_PG = 'docker'
const name = `o3dfm-spool-usage-${randomBytes(4).toString('hex')}`
const ledgerDir = join(tmpdir(), 'o3dfm-spool-usage-543')
mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
const ledger = (entry) =>
  appendFileSync(
    join(ledgerDir, 'resources.jsonl'),
    JSON.stringify(entry) + '\n',
    { mode: 0o600 },
  )
const fixture = disposablePostgres({
  name,
  image,
  docker,
  labelKey: 'o3dfm.task',
  labelValue: 'spool-usage-543',
  ledger,
})
let sql
try {
  sql = await fixture.start()
  await sql`CREATE ROLE spool_usage_test LOGIN IN ROLE farm_spool_features, farm_spool_library, farm_job_history_reader, farm_integration_apps`
  await sql.unsafe(
    `ALTER ROLE "spool_usage_test" PASSWORD '${fixture.password}'`,
  )
  const result = await exec(
    process.execPath,
    ['--test', 'tests/integration/spool-usage/usage.test.ts'],
    {
      env: {
        ...process.env,
        SPOOL_USAGE_TEST_DATABASE_URL: `postgres://fixture:${fixture.password}@127.0.0.1:${fixture.port}/fixture`,
        SPOOL_USAGE_FEATURE_DATABASE_URL: `postgres://spool_usage_test:${fixture.password}@127.0.0.1:${fixture.port}/fixture`,
      },
      timeout: 120000,
    },
  ).catch((error) => {
    process.stdout.write(error.stdout ?? '')
    process.stderr.write(error.stderr ?? '')
    throw error
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} finally {
  await sql?.end({ timeout: 3 }).catch(() => {})
  await fixture.stop()
  assert.equal(await docker('ps', '-aq', '--filter', `name=^/${name}$`), '')
  ledger({ resource: 'container', name, state: 'removed' })
  console.log(`Removed disposable PostgreSQL container ${name}`)
}
