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
import { createServer } from 'node:net'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
} from '../tests/helpers/disposable-postgres.ts'
import { runConnectorOutageScenarios } from '../tests/helpers/connector-outage-scenarios.ts'
import { interruption } from '../tests/helpers/connector-outage-fixtures.ts'

const exec = promisify(execFile)
const env = process.env
const image = env.OUTAGE_TEST_IMAGE
const base = Number(env.OUTAGE_TEST_PORT_BASE)
const workRoot = env.OUTAGE_TEST_WORK_ROOT
if (
  process.argv.length !== 2 ||
  env.OUTAGE_TEST_ADMITTED !== 'yes' ||
  !image ||
  !POSTGRES_IMAGE_PATTERN.test(image) ||
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
// Admission: every port must be free on loopback before anything is created.
for (const port of Object.values(ports))
  await new Promise<void>((resolveProbe, reject) => {
    const probe = createServer()
    probe.once('error', () =>
      reject(
        new Error(
          `Port ${port} is in use; choose another OUTAGE_TEST_PORT_BASE`,
        ),
      ),
    )
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveProbe()))
  })
const id = randomUUID()
const prefix = env.OUTAGE_TEST_NAME_PREFIX ?? 'o3dfm-outage'
if (!/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix))
  throw new Error('Invalid outage test name prefix')
const name = prefix + '-' + id
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
const endpoint =
  env.DOCKER_HOST ??
  (await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
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
const database = disposablePostgres({
  docker,
  image,
  name,
  labelKey: 'org.open3dfarmmanager.outage-test',
  labelValue: id,
  port: ports.db,
  ledger,
})
let failure: unknown
let cleanupFailure: unknown
let report: Awaited<ReturnType<typeof runConnectorOutageScenarios>> | undefined
try {
  const available = BigInt(await disk())
  assert.ok(available >= 2n * 1024n ** 3n, 'At least 2 GiB free required')
  const sql = await database.start()
  report = await runConnectorOutageScenarios({
    admin: sql,
    ports,
    workDir,
    container: database.container!,
    docker,
    ledger,
  })
  if (interrupted) throw interrupted
} catch (error) {
  failure = interrupted ?? error
  if (database.container)
    await writeFile(
      join(workRoot, id + '.postgres.log'),
      await database.logs(),
      {
        mode: 0o600,
      },
    )
} finally {
  try {
    await database.stop()
  } catch (error) {
    cleanupFailure = error
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
