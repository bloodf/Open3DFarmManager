import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disposablePostgres,
  POSTGRES_IMAGE_PATTERN,
} from '../tests/helpers/disposable-postgres.ts'
import assert from 'node:assert/strict'
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
const name = `o3dfm-labels-drying-${randomBytes(4).toString('hex')}`
const ledgerDir = join(tmpdir(), 'o3dfm-labels-drying-543')
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
  labelValue: 'labels-drying-543',
  ledger,
})
let sql
try {
  sql = await fixture.start()
  await sql`CREATE ROLE spool_drying_test LOGIN IN ROLE farm_spool_features`
  await sql.unsafe(
    `ALTER ROLE "spool_drying_test" PASSWORD '${fixture.password}'`,
  )
  const result = await exec(
    process.execPath,
    [
      '--test',
      'tests/integration/spool-labels-drying/store.test.ts',
      'tests/unit/qr-label.test.ts',
    ],
    {
      env: {
        ...process.env,
        SPOOL_DRYING_TEST_DATABASE_URL: `postgres://fixture:${fixture.password}@127.0.0.1:${fixture.port}/fixture`,
        SPOOL_DRYING_FEATURE_DATABASE_URL: `postgres://spool_drying_test:${fixture.password}@127.0.0.1:${fixture.port}/fixture`,
      },
      timeout: 120000,
    },
  )
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} finally {
  await sql?.end({ timeout: 3 }).catch(() => {})
  await fixture.stop()
  assert.equal(await docker('ps', '-aq', '--filter', `name=^/${name}$`), '')
  ledger({ resource: 'container', name, state: 'removed' })
  console.log(`Removed disposable PostgreSQL container ${name}`)
}
