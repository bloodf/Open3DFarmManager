// Evidence for the Spoolman v0.27.1 auxiliary HTTP APIs (#545, #562) on the
// farm-scoped legacy path: info, health, backup, settings, extra fields,
// locations, export, the distinct-value lists, search, spool groups and the
// external filament library.
//
// Starts one disposable PostgreSQL 17 Docker container (digest-pinned local
// image, never pulled, loopback port, read-only root, removed on exit), applies
// every migration through 0089, creates the runtime login role, then runs
// tests/integration/spoolman-aux/** against the built-in handler over a
// loopback HTTP server. Nothing touches printers, host services or another
// task's resources; the container is verified removed before exit.
//
//   node scripts/test-spoolman-aux-api.mjs
//
// Optional: SPOOL_AUX_API_EVIDENCE_DIR (ledger + diagnostics, outside the
// repo), SPOOL_LIBRARY_TEST_IMAGE (a postgres:17@sha256:... present locally).
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
} from '../tests/helpers/disposable-postgres.ts'
import { validateSpoolLibraryRole } from '../apps/farm/server/utils/spool-library/role-policy.ts'

const exec = promisify(execFile)
const MIGRATION = '0089_spool_features_schema'
const TASK_LABEL = 'spoolman-aux-api-545'
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const testDir = join(repoRoot, 'tests/integration/spoolman-aux')
if (process.argv.length !== 2)
  throw new Error(
    'No arguments accepted: node scripts/test-spoolman-aux-api.mjs',
  )

const evidenceDir = resolve(
  process.env.SPOOL_AUX_API_EVIDENCE_DIR ??
    (await mkdtemp(join(tmpdir(), 'o3dfm-spoolman-aux-'))),
)
const inside = relative(repoRoot, evidenceDir)
if (inside === '' || (!inside.startsWith('..') && !inside.startsWith('/')))
  throw new Error('Evidence directory must be outside the repository')
await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
const ledgerPath = join(evidenceDir, 'ledger.jsonl')
const ledger = (entry) =>
  appendFileSync(
    ledgerPath,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  )

const docker = async (...args) =>
  (
    await exec('docker', args, {
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout.trim()
const endpoint =
  process.env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
const image =
  process.env.SPOOL_LIBRARY_TEST_IMAGE ??
  (
    await docker(
      'image',
      'inspect',
      'postgres:17',
      '--format',
      '{{index .RepoDigests 0}}',
    )
  ).replace(/^postgres@/, 'postgres:17@')
assert.match(
  image,
  POSTGRES_IMAGE_PATTERN,
  'A digest-pinned postgres:17 image must exist locally',
)

process.env.OPENFARM_PG = 'docker'
const containerName = `o3dfm-spoolman-aux-545-${randomBytes(4).toString('hex')}`
const fixture = disposablePostgres({
  name: containerName,
  labelKey: 'o3dfm.task',
  labelValue: TASK_LABEL,
  docker,
  image,
  ledger,
  through: MIGRATION,
})

let runtime
try {
  const admin = await fixture.start()
  ledger({
    resource: 'container',
    name: containerName,
    image,
    port: fixture.port,
  })
  const role = 'spoolman_aux_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library, farm_spool_features`
  runtime = postgres({
    host: '127.0.0.1',
    port: fixture.port,
    database: 'fixture',
    username: role,
    password: '',
    ssl: false,
    max: 2,
    connect_timeout: 3,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
  await validateSpoolLibraryRole(runtime)
  console.log('role policy accepts farm_spool_library + farm_spool_features')
  await runtime.end({ timeout: 3 })
  runtime = undefined

  const files = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(testDir, name))
  assert.ok(files.length > 0, 'no tests under tests/integration/spoolman-aux')
  const code = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', ...files],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          AUX_PG_PORT: String(fixture.port),
          AUX_PG_ROLE: role,
          // The default module list reads this when imported: keep it unset so
          // the "no external library configured" behaviour is what is tested.
          SPOOLMAN_EXTERNAL_DB_URL: '',
        },
      },
    )
    child.on('exit', (status, signal) => done(status ?? (signal ? 1 : 0)))
  })
  if (code !== 0) process.exitCode = 1
  ledger({ result: 'tests', exitCode: code })
} catch (error) {
  process.exitCode = 1
  console.error(
    `FAILED: ${(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 4000)}`,
  )
} finally {
  await runtime?.end({ timeout: 3 }).catch(() => {})
  try {
    await fixture.stop()
  } catch (error) {
    console.error(
      `Container removal reported: ${String(error).split('\n', 1)[0]}`,
    )
  }
  let leftover = ''
  for (let attempt = 0; attempt < 45; attempt++) {
    leftover = await docker(
      'ps',
      '-aq',
      '--filter',
      `name=^/${containerName}$`,
    ).catch(() => 'unknown')
    if (leftover === '') break
    if (/^[a-f0-9]+$/.test(leftover))
      await docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "o3dfm.task"}}',
        leftover,
      )
        .then((label) =>
          label === TASK_LABEL ? docker('rm', '-f', '-v', leftover) : undefined,
        )
        .catch(() => {})
    await new Promise((done) => setTimeout(done, 2000))
  }
  ledger({
    cleanup: 'container',
    name: containerName,
    remaining: leftover === '' ? 'none' : leftover,
  })
  if (leftover !== '') {
    process.exitCode = 1
    console.error(
      `Cleanup incomplete: container ${containerName} still present`,
    )
  } else
    console.log(
      `Cleanup: container ${containerName} removed; ledger ${ledgerPath}`,
    )
}
