// Explicit test-only runner: Connector outage and restart acceptance (issue #6).
// Disposable digest-pinned PostgreSQL 17, built farm server, real Connector CLI
// process and a synthetic loopback Moonraker. Never contacts a physical printer,
// never accepts a database URL or an existing container. Needs a built app:
// pnpm --dir apps/farm build
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { access, mkdir, rm, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { runConnectorOutageScenarios } from '../tests/helpers/connector-outage-scenarios.ts'

const exec = promisify(execFile)
const env = process.env
const image = env.OUTAGE_TEST_IMAGE
const base = Number(env.OUTAGE_TEST_PORT_BASE)
const workRoot = env.OUTAGE_TEST_WORK_ROOT
if (
  process.argv.length !== 2 ||
  env.OUTAGE_TEST_ADMITTED !== 'yes' ||
  !image ||
  !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(
    image,
  ) ||
  !Number.isInteger(base) ||
  base < 1024 ||
  base > 65530 ||
  !workRoot ||
  !isAbsolute(workRoot) ||
  !relative(process.cwd(), workRoot).startsWith('..')
)
  throw new Error(
    'OUTAGE_TEST_ADMITTED=yes, a locally available digest-pinned PostgreSQL 17 OUTAGE_TEST_IMAGE, OUTAGE_TEST_PORT_BASE (uses base..base+3) and an absolute OUTAGE_TEST_WORK_ROOT outside the repository are required',
  )
await access(new URL('../apps/farm/.output/server/index.mjs', import.meta.url))
const ports = { db: base, app: base + 1, proxy: base + 2, moonraker: base + 3 }
const id = randomUUID()
const prefix = env.OUTAGE_TEST_NAME_PREFIX ?? 'o3dfm-outage'
if (!/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix))
  throw new Error('Invalid outage test name prefix')
const name = prefix + '-' + id
const label = 'org.open3dfarmmanager.outage-test=' + id
const workDir = join(workRoot, id)
const ledgerPath = join(workRoot, id + '.ledger.jsonl')
const resultPath = join(workRoot, id + '.result.json')
await mkdir(workDir, { recursive: true, mode: 0o700 })
const ledger = (value: object) =>
  appendFileSync(ledgerPath, JSON.stringify(value) + '\n', { mode: 0o600 })
ledger({ resource: 'work-directory', path: workDir, ports })
const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()
const disk = async () =>
  String(
    await statfs(workRoot, { bigint: true }).then((x) => x.bavail * x.bsize),
  )
const startedAt = performance.now()
let container: string | undefined
let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
let report: Awaited<ReturnType<typeof runConnectorOutageScenarios>> | undefined
try {
  const available = BigInt(await disk())
  assert.ok(available >= 2n * 1024n ** 3n, 'At least 2 GiB free required')
  // Fails rather than pulling: image ownership and deletion remain with its owner.
  await docker('image', 'inspect', image)
  ledger({ resource: 'container', name, label, image })
  await docker(
    ...['create', '--name', name, '--label', label, '--pull', 'never'],
    ...['--cpus', '2', '--memory', '2g', '--read-only', '--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges', '--user', 'postgres'],
    ...['--tmpfs', '/var/lib/postgresql/data:rw,mode=1777'],
    ...['--tmpfs', '/var/run/postgresql:rw,mode=1777'],
    ...['--tmpfs', '/tmp:rw,mode=1777'],
    ...['-p', `127.0.0.1:${ports.db}:5432`],
    ...['-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture'],
    ...['-e', 'POSTGRES_HOST_AUTH_METHOD=trust'],
    ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
    image,
  )
  container = await docker('inspect', '--format', '{{.Id}}', name)
  assert.match(container, /^[a-f0-9]{64}$/)
  ledger({ resource: 'container-id', id: container })
  await docker('start', container)
  await docker(
    ...['exec', container, 'sh', '-c'],
    'n=0; until pg_isready -U fixture -d fixture >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
  )
  sql = postgres({
    host: '127.0.0.1',
    port: ports.db,
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
  const catalog = await loadMigrationCatalog()
  await runMigrations(sql, catalog, { kind: 'up' })
  const journal =
    await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
  assert.equal(validateMigrationHistory(catalog, [...journal]), catalog.length)
  report = await runConnectorOutageScenarios({
    admin: sql,
    ports,
    workDir,
    container,
    docker,
    ledger,
  })
} catch (error) {
  failure = error
  if (container)
    await writeFile(
      join(workRoot, id + '.postgres.log'),
      await docker('logs', '--tail', '200', container).catch(String),
      { mode: 0o600 },
    )
} finally {
  try {
    await sql?.end({ timeout: 3 })
  } catch (error) {
    cleanupFailure = error
  }
  try {
    // Exact owned container only: verified by ID, name and label.
    const owned =
      container ??
      (await docker('inspect', '--format', '{{.Id}}', name).catch(() => ''))
    if (owned) {
      assert.equal(
        await docker(
          ...['inspect', '--format'],
          '{{index .Config.Labels "org.open3dfarmmanager.outage-test"}} {{.Name}}',
          owned,
        ),
        `${id} /${name}`,
      )
      await docker('rm', '-f', owned)
      assert.equal(await docker('ps', '-aq', '--filter', 'id=' + owned), '')
      ledger({ removed: 'container', id: owned })
    }
  } catch (error) {
    cleanupFailure ??= error
  }
  // Secrets (keys, credential, identity) live only in the work directory; logs are kept on failure.
  if (!failure)
    try {
      await rm(workDir, { recursive: true })
      ledger({ removed: 'work-directory', path: workDir })
    } catch (error) {
      cleanupFailure ??= error
    }
  const result = {
    result: failure ? 'failed' : 'passed',
    error:
      failure instanceof Error
        ? failure.stack
        : failure
          ? String(failure)
          : null,
    totalMs: Math.round(performance.now() - startedAt),
    image,
    ...report,
    cleanup: cleanupFailure ? String(cleanupFailure) : 'complete',
    retainedEvidence: failure ? workDir : null,
    diskAvailableBytes: await disk().catch(() => null),
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result, null, 2))
}
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
