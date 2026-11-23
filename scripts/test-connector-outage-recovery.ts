// Explicit test-only runner: Connector outage and restart acceptance (issue #6).
// Built farm server, real Connector CLI process and a synthetic loopback
// Moonraker. Never contacts a physical printer, never accepts a database URL or
// an existing container. Needs a built app: npm run build -w @open3dfarmmanager/farm
//   OPENFARM_SIM=mock (default): disposable local PostgreSQL 17 cluster behind the
//     loopback fault proxy; a database freeze is a proxy blackhole. No Docker.
//   OPENFARM_SIM=docker (opt-in): disposable digest-pinned PostgreSQL 17 container
//     (OUTAGE_TEST_ADMITTED, OUTAGE_TEST_IMAGE, OUTAGE_TEST_PORT_BASE and
//     OUTAGE_TEST_WORK_ROOT required); a freeze is `docker pause`.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { runConnectorOutageScenarios } from '../tests/helpers/connector-outage-scenarios.ts'
import { interruption } from '../tests/helpers/connector-outage-fixtures.ts'
import { startLocalPostgres } from '../tests/helpers/connector-outage-local-postgres.ts'
import { createNetFaultProxy } from '../infra/sim/netfault/fault-proxy.ts'
import { isDockerSim } from '../packages/sim-tools/src/mocks/env.ts'

const exec = promisify(execFile)
const env = process.env
const dockerMode = isDockerSim()
const image = env.OUTAGE_TEST_IMAGE
// Mock mode: five consecutive loopback ports (db proxy, app, TLS front,
// Moonraker, real PostgreSQL), found from a default start when none is given.
const freePort = (port: number) =>
  new Promise<boolean>((resolveProbe) => {
    const probe = createServer()
    probe.once('error', () => resolveProbe(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveProbe(true)))
  })
let base = Number(env.OUTAGE_TEST_PORT_BASE)
if (!dockerMode && !env.OUTAGE_TEST_PORT_BASE)
  for (base = 43100; base < 60000; base += 10) {
    const free = await Promise.all(
      [0, 1, 2, 3, 4].map((n) => freePort(base + n)),
    )
    if (free.every(Boolean)) break
  }
// Mock mode owns a private work root and removes it; Docker mode takes the caller's.
const ownedWorkRoot =
  !dockerMode && !env.OUTAGE_TEST_WORK_ROOT
    ? mkdtempSync(join(tmpdir(), 'o3dfm-outage-'))
    : undefined
const workRoot = ownedWorkRoot ?? env.OUTAGE_TEST_WORK_ROOT
if (
  process.argv.length !== 2 ||
  (dockerMode &&
    (env.OUTAGE_TEST_ADMITTED !== 'yes' ||
      !image ||
      !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(
        image,
      ))) ||
  !Number.isInteger(base) ||
  base < 1024 ||
  base > 65530 ||
  !workRoot ||
  !isAbsolute(workRoot) ||
  !relative(process.cwd(), workRoot).startsWith('..')
)
  throw new Error(
    'OPENFARM_SIM=docker needs OUTAGE_TEST_ADMITTED=yes, a locally available digest-pinned PostgreSQL 17 OUTAGE_TEST_IMAGE, OUTAGE_TEST_PORT_BASE (uses base..base+3) and an absolute OUTAGE_TEST_WORK_ROOT outside the repository; the default OPENFARM_SIM=mock needs only PostgreSQL 17 binaries on PATH or OUTAGE_TEST_PG_BIN',
  )
await access(new URL('../apps/farm/.output/server/index.mjs', import.meta.url))
// db is the address under test: the real server in Docker mode, the fault proxy
// in mock mode. The real mock-mode cluster listens on base+4.
const ports = { db: base, app: base + 1, proxy: base + 2, moonraker: base + 3 }
const realDbPort = dockerMode ? base : base + 4
// Admission: every port must be free on loopback before anything is created.
for (const port of dockerMode
  ? Object.values(ports)
  : [...Object.values(ports), realDbPort])
  if (!(await freePort(port)))
    throw new Error(
      `Port ${port} is in use; choose another OUTAGE_TEST_PORT_BASE`,
    )
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
if (dockerMode) {
  const endpoint =
    env.DOCKER_HOST ??
    (await docker(
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ))
  assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
}
// Signals and stray errors unwind the scenario waits into the same cleanup below.
let interrupted: unknown
const interrupt = (reason: unknown) => {
  interrupted ??= reason
  interruption.abort()
}
process.once('SIGINT', () => interrupt(new Error('SIGINT')))
process.once('SIGTERM', () => interrupt(new Error('SIGTERM')))
process.on('uncaughtException', interrupt)
process.on('unhandledRejection', interrupt)
const disk = async () =>
  String(
    await statfs(workRoot, { bigint: true }).then((x) => x.bavail * x.bsize),
  )
const startedAt = performance.now()
let container: string | undefined
let local: Awaited<ReturnType<typeof startLocalPostgres>> | undefined
let dbPassword = randomBytes(32).toString('hex')
let faultProxy: ReturnType<typeof createNetFaultProxy> | undefined
let dbStall:
  Parameters<typeof runConnectorOutageScenarios>[0]['dbStall'] | undefined
let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
let report: Awaited<ReturnType<typeof runConnectorOutageScenarios>> | undefined
try {
  const available = BigInt(await disk())
  assert.ok(available >= 2n * 1024n ** 3n, 'At least 2 GiB free required')
  if (dockerMode) {
    // Fails rather than pulling: image ownership and deletion remain with its owner.
    await docker('image', 'inspect', image!)
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
      ...['-e', `POSTGRES_PASSWORD=${dbPassword}`],
      ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
      image!,
    )
    container = await docker('inspect', '--format', '{{.Id}}', name)
    assert.match(container, /^[a-f0-9]{64}$/)
    ledger({ resource: 'container-id', id: container })
    await docker('start', container)
    // TCP readiness: the image's init-time server listens only on the Unix socket and
    // restarts afterwards, so socket readiness can reset the first host connection.
    await docker(
      ...['exec', container, 'sh', '-c'],
      'n=0; until pg_isready -h 127.0.0.1 -U fixture -d fixture >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
    )
    dbStall = {
      stall: async () => void (await docker('pause', container!)),
      resume: async () => void (await docker('unpause', container!)),
    }
  } else {
    local = await startLocalPostgres({
      workDir,
      port: realDbPort,
      ledger,
    })
    dbPassword = local.password
    // The fault proxy fronts the cluster: a blackhole freezes every connection,
    // established or new, like `docker pause`, and releases queued bytes on resume.
    faultProxy = createNetFaultProxy()
    await faultProxy.forwardTcp({
      listenPort: ports.db,
      targetPort: realDbPort,
    })
    ledger({ resource: 'loopback-db-fault-proxy', port: ports.db })
    const proxied = faultProxy
    dbStall = {
      stall: async () => void proxied.set({ blackhole: true }),
      resume: async () => void proxied.set({ blackhole: false }),
    }
  }
  sql = postgres({
    host: '127.0.0.1',
    port: ports.db,
    database: 'fixture',
    username: 'fixture',
    password: dbPassword,
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
    dbStall: dbStall!,
    ledger,
  })
  if (interrupted) throw interrupted
} catch (error) {
  failure = interrupted ?? error
  if (local)
    await copyFile(local.logPath, join(workRoot, id + '.postgres.log')).catch(
      () => {},
    )
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
    // Mock mode: lift any blackhole, close the proxy, stop the exact postmaster started here.
    await faultProxy?.close()
    await local?.stop()
  } catch (error) {
    cleanupFailure ??= error
  }
  try {
    // Exact owned container only: verified by ID, name and label.
    const owned =
      container ??
      (dockerMode
        ? await docker('inspect', '--format', '{{.Id}}', name).catch(() => '')
        : '')
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
    mode: dockerMode ? 'docker' : 'mock',
    image: image ?? null,
    ...report,
    cleanup: cleanupFailure ? String(cleanupFailure) : 'complete',
    retainedEvidence: failure ? workDir : null,
    diskAvailableBytes: await disk().catch(() => null),
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(result, null, 2))
  // The private mock-mode work root goes last, after its result was printed.
  if (ownedWorkRoot && !failure && !cleanupFailure)
    await rm(ownedWorkRoot, { recursive: true, force: true }).catch(
      (error) => void (cleanupFailure ??= error),
    )
}
// The uncaughtException handler above would turn a throw into exit code 0.
if (failure || cleanupFailure) process.exitCode = 1
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
