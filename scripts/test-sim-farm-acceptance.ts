import { isDockerSim } from '../packages/sim-tools/src/mocks/env.ts'
import { mockSimulatorStack } from '../tests/helpers/sim-acceptance-mocks.ts'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
// Explicit test-only runner: two-printer / four-tool / Spoolman simulator
// acceptance (issue #2). Starts the infra/sim Compose stack under its own
// project, a disposable digest-pinned PostgreSQL 17, the built farm server and
// the real Connector CLI. Read-only: never sends a printer command and never
// contacts a physical printer. Needs a built app: npm run build -w @open3dfarmmanager/farm
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { access, mkdir, rm, statfs, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  getFreePort,
} from '../tests/helpers/disposable-postgres.ts'
import { interruption } from '../tests/helpers/connector-outage-fixtures.ts'
import {
  runSimFarmAcceptance,
  simPorts,
  simulatorStack,
} from '../tests/helpers/sim-farm-acceptance.ts'

const exec = promisify(execFile)
const env = process.env
const dockerSim = isDockerSim()
const dockerPg = env.OPENFARM_PG === 'docker'
const image = env.SIM_ACCEPT_IMAGE
const base = Number(
  env.SIM_ACCEPT_PORT_BASE ?? (dockerSim || dockerPg ? NaN : 0),
)
const requestedRoot = env.SIM_ACCEPT_WORK_ROOT
const project = env.SIM_ACCEPT_PROJECT ?? 'o3dfm-sim-accept'
if (
  process.argv.length !== 2 ||
  ((dockerSim || dockerPg) && env.SIM_ACCEPT_ADMITTED !== 'yes') ||
  (dockerPg && (!image || !POSTGRES_IMAGE_PATTERN.test(image))) ||
  !Number.isInteger(base) ||
  (base < 1024 && base !== 0) ||
  base > 65526 ||
  ((dockerSim || dockerPg) && (!requestedRoot || base === 0)) ||
  (requestedRoot !== undefined &&
    (!isAbsolute(requestedRoot) ||
      !relative(process.cwd(), requestedRoot).startsWith('..'))) ||
  !/^o3dfm-[a-z0-9-]{1,40}$/.test(project)
)
  throw new Error(
    'SIM_ACCEPT_ADMITTED=yes, a locally available digest-pinned PostgreSQL 17 SIM_ACCEPT_IMAGE, SIM_ACCEPT_PORT_BASE (uses base..base+8), an absolute SIM_ACCEPT_WORK_ROOT outside the repository and an optional o3dfm-* SIM_ACCEPT_PROJECT are required',
  )
const serverBuild = new URL(
  '../apps/farm/.output/server/index.mjs',
  import.meta.url,
)
if (!existsSync(serverBuild))
  execFileSync('npm', ['run', 'build', '-w', '@open3dfarmmanager/farm'], {
    stdio: 'inherit',
    timeout: 900_000,
  })
await access(serverBuild)
const ports = simPorts(base)
if (!base) {
  const allocated = new Set<number>()
  for (const key of ['db', 'app', 'proxy'] as const) {
    let port: number
    do port = await getFreePort()
    while (allocated.has(port))
    allocated.add(port)
    ports[key] = port
  }
}
for (const port of base ? Object.values(ports) : [])
  await new Promise<void>((resolveProbe, reject) => {
    const probe = createServer()
    probe.once('error', () =>
      reject(
        new Error(
          `Port ${port} is in use; choose another SIM_ACCEPT_PORT_BASE`,
        ),
      ),
    )
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveProbe()))
  })
const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()
if (dockerSim || dockerPg) {
  const endpoint =
    env.DOCKER_HOST ??
    (await docker(
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ))
  assert.match(endpoint, /^unix:\/\//, 'Only a local Docker daemon is allowed')
  assert.equal(
    await docker(
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ),
    '',
    `Compose project ${project} already has containers`,
  )
}
const workRoot =
  requestedRoot ?? (await mkdtemp(join(tmpdir(), 'openfarm-sim-accept-')))
const id = randomUUID()
const workDir = join(workRoot, id)
const ledgerPath = join(workRoot, id + '.ledger.jsonl')
const resultPath = join(workRoot, id + '.result.json')
await mkdir(workDir, { recursive: true, mode: 0o700 })
const ledger = (value: object) =>
  appendFileSync(ledgerPath, JSON.stringify(value) + '\n', { mode: 0o600 })
ledger({ resource: 'work-directory', path: workDir, ports })
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
  isolated: true,
  ...(dockerPg ? { docker, image } : {}),
  name: `${project}-db-${id}`,
  labelKey: 'org.open3dfarmmanager.sim-acceptance',
  labelValue: id,
  port: ports.db,
  ledger,
})
const mocks = dockerSim ? undefined : mockSimulatorStack()
const stack = mocks ?? simulatorStack({ project, ports, workDir, ledger })
let failure: unknown
let cleanupFailure: unknown
let report: Awaited<ReturnType<typeof runSimFarmAcceptance>> | undefined
try {
  assert.ok(BigInt(await disk()) >= 10n * 1024n ** 3n, 'At least 10 GiB free')
  await stack.up()
  const admin = await database.start()
  report = await runSimFarmAcceptance({
    admin,
    fixtureDatabaseUrl: database.connectionString,
    ports,
    workDir,
    ledger,
    ...(mocks ? { origins: mocks.origins } : {}),
  })
  if (interrupted) throw interrupted
} catch (error) {
  failure = interrupted ?? error
  await writeFile(
    join(workRoot, id + '.compose.log'),
    await stack.logs().catch(String),
    {
      mode: 0o600,
    },
  )
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
  try {
    await stack.down()
  } catch (error) {
    cleanupFailure ??= error
  }
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
if (!requestedRoot && !failure && !cleanupFailure)
  await rm(workRoot, { recursive: true })
if (failure || cleanupFailure) process.exitCode = 1
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
