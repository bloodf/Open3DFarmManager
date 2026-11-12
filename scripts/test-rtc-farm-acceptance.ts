// One-command real-RTC farm-page acceptance (issues #8/#9; Phase 0 base).
// Disposable digest-pinned PostgreSQL 17 (never pulled), throwaway TLS CA and
// keys in a private work directory, sealed built farm server over HTTPS, real
// native Connector (node-datachannel) with a loopback fake Moonraker, and
// Playwright Chromium on the real farm page. Never contacts a printer, never
// accepts a database URL or an existing container. See
// docs/RTC-FARM-ACCEPTANCE-CHECKPOINT.md.
import assert from 'node:assert/strict'
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, statfs } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from './db/migrations.ts'
import { selectRtcFarmScenarios } from '../tests/helpers/rtc-farm-acceptance-scenarios.ts'
import { startRtspCamera } from '../tests/helpers/rtc-farm-rtsp-camera.ts'

const exec = promisify(execFile)
const env = process.env
const checkout = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const image = env.RTC_FARM_TEST_IMAGE
const dbPort = Number(env.RTC_FARM_TEST_DB_PORT)
const workRoot = env.RTC_FARM_TEST_WORK_ROOT
const runs = Number(env.RTC_FARM_TEST_REPEAT ?? '1')
if (
  process.argv.length !== 2 ||
  env.RTC_FARM_TEST_ADMITTED !== 'yes' ||
  !image ||
  !/^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(
    image,
  ) ||
  !Number.isInteger(dbPort) ||
  dbPort < 1024 ||
  dbPort > 65535 ||
  !workRoot ||
  !isAbsolute(workRoot) ||
  !relative(checkout, workRoot).startsWith('..') ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 5
)
  throw new Error(
    'RTC_FARM_TEST_ADMITTED=yes, a locally available digest-pinned PostgreSQL 17 RTC_FARM_TEST_IMAGE, a loopback RTC_FARM_TEST_DB_PORT and an absolute RTC_FARM_TEST_WORK_ROOT outside the repository are required',
  )
const scenarios = selectRtcFarmScenarios(env.RTC_FARM_TEST_SCENARIOS)
// Camera rows need a prebuilt ingest helper (its hash is pinned in tracked
// code) and a loopback RTSP port.
const camera = scenarios.some((row) => row.resources?.includes('rtsp-camera'))
  ? {
      helper: env.RTC_FARM_TEST_RTSP_HELPER ?? '',
      port: Number(env.RTC_FARM_TEST_RTSP_PORT),
    }
  : undefined
if (
  camera &&
  (!isAbsolute(camera.helper) ||
    !Number.isInteger(camera.port) ||
    camera.port < 1024 ||
    camera.port > 65535 ||
    camera.port === dbPort)
)
  throw new Error(
    'Camera rows need RTC_FARM_TEST_RTSP_HELPER (absolute) and RTC_FARM_TEST_RTSP_PORT',
  )
const prefix = env.RTC_FARM_TEST_NAME_PREFIX ?? 'o3dfm-rtc-farm'
if (!/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix))
  throw new Error('Invalid RTC farm test name prefix')
const id = randomUUID()
const name = prefix + '-' + id
const label = 'org.open3dfarmmanager.rtc-farm-test=' + id
const workDir = join(workRoot, id)
const evidence = join(homedir(), '.local/state/o3dfm/rtc-farm-tests', id)
const ledgerPath = join(evidence, 'resources.jsonl')
const ledger = (value: object) => {
  try {
    appendFileSync(ledgerPath, JSON.stringify(value) + '\n', { mode: 0o600 })
  } catch {
    // Evidence is best effort; cleanup below never depends on it.
  }
}

const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()

// Children get an allowlisted environment, never the caller's secrets.
const ALLOWED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'PLAYWRIGHT_BROWSERS_PATH',
  'XDG_CACHE_HOME',
]
const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
  ALLOWED_ENV.flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
)
childEnv.TMPDIR = workDir

const KILL_GRACE_MS = 5000
const LOG_LIMIT_BYTES = 8 * 1024 * 1024
let current: ChildProcess | undefined
const signalGroup = (child: ChildProcess | undefined, name: NodeJS.Signals) => {
  try {
    if (child?.pid) process.kill(-child.pid, name)
  } catch {
    /* group gone */
  }
}
/** SIGTERM the group, then SIGKILL it if it is still there after the grace. */
const stopGroup = (child: ChildProcess | undefined) => {
  signalGroup(child, 'SIGTERM')
  setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref()
}

// First signal: stop the current group and let finally clean up. Second
// signal: best-effort synchronous cleanup of exactly this run, then exit.
let interrupted = false
const interrupt = () => {
  if (interrupted) {
    signalGroup(current, 'SIGKILL')
    try {
      execFileSync('docker', ['rm', '--force', name], { timeout: 15000 })
    } catch {
      /* not created or already removed */
    }
    try {
      // Exact compose project of this run's RTSP simulator, if one was started.
      if (camera)
        execFileSync(
          'docker',
          [
            'compose',
            '--project-name',
            name + '-rtsp',
            '-f',
            join(checkout, 'infra/sim/docker-compose.yml'),
            '-f',
            join(workDir, 'rtsp-override.yml'),
            '--profile',
            'rtsp',
            'down',
            '--timeout',
            '1',
          ],
          { timeout: 30000 },
        )
    } catch {
      /* not started or already removed */
    }
    rmSync(workDir, { recursive: true, force: true })
    process.exit(130)
  }
  interrupted = true
  stopGroup(current)
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

/** Runs one owned process group; output goes to a size-capped evidence log. */
async function run(
  step: string,
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<number> {
  if (interrupted) throw new Error('Interrupted')
  const log = createWriteStream(join(evidence, step + '.log'), { mode: 0o600 })
  let logged = 0
  const write = (chunk: Buffer) => {
    if (logged >= LOG_LIMIT_BYTES) return
    const part = chunk.subarray(0, LOG_LIMIT_BYTES - logged)
    logged += part.length
    log.write(part)
    if (logged >= LOG_LIMIT_BYTES) log.write('\n[log truncated]\n')
  }
  const child = spawn(command, args, {
    cwd: options.cwd ?? checkout,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  current = child
  ledger({ resource: 'process-group', step, pid: child.pid })
  child.stdout?.on('data', write)
  child.stderr?.on('data', write)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stopGroup(child)
  }, options.timeoutMs)
  try {
    // 'close' waits for both pipes to drain, so the log is complete.
    const [code, signal] = await once(child, 'close')
    if (timedOut) ledger({ timeout: step, ms: options.timeoutMs })
    return timedOut || signal ? 128 : (code as number)
  } finally {
    clearTimeout(timer)
    current = undefined
    // A surviving group after its leader exited is owned and must not linger.
    signalGroup(child, 'SIGKILL')
    await new Promise<void>((resolve) => log.end(resolve))
  }
}

let rtsp: Awaited<ReturnType<typeof startRtspCamera>> | undefined
let container: string | undefined
let createAttempted = false
const CREATE_SETTLE_MS = 90000
let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
const results: {
  run: number
  scenario: string
  passed: boolean
  ms: number
  readonlyMs?: number
  recoveredMs?: number
  pauseAppliedMs?: number
}[] = []
try {
  await mkdir(workDir, { recursive: true, mode: 0o700 })
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  ledger({ resource: 'work-directory', path: workDir, dbPort })
  const free = await statfs(workRoot, { bigint: true })
  assert.ok(free.bavail * free.bsize >= 4n * 1024n ** 3n, 'Need 4 GiB free')
  assert.equal(
    (await exec('git', ['status', '--porcelain'], { cwd: checkout })).stdout,
    '',
    'The sealed build requires a clean checkout',
  )
  // Fails rather than pulling: image ownership and deletion remain with its owner.
  await docker('image', 'inspect', image)
  ledger({ resource: 'container', name, label, image })
  createAttempted = true
  await docker(
    ...['create', '--name', name, '--label', label, '--pull', 'never'],
    ...['--cpus', '4', '--memory', '4g', '--read-only', '--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges', '--user', 'postgres'],
    ...['--tmpfs', '/var/lib/postgresql/data:rw,mode=1777'],
    ...['--tmpfs', '/var/run/postgresql:rw,mode=1777'],
    ...['--tmpfs', '/tmp:rw,mode=1777'],
    ...['-p', `127.0.0.1:${dbPort}:5432`],
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
    port: dbPort,
    database: 'fixture',
    username: 'fixture',
    password: '',
    ssl: false,
    max: 2,
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
  assert.equal(
    validateMigrationHistory(catalog, [
      ...(await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`),
    ]),
    catalog.length,
  )
  await sql.end({ timeout: 3 })
  sql = undefined

  // Sealed signalling build layer, entirely inside the private work directory.
  const layer = join(workDir, 'layer')
  const harness = join(checkout, 'scripts/test-signalling-https.ts')
  const nodeEnv = childEnv
  assert.equal(
    await run(
      'prepare-layer',
      process.execPath,
      [harness, '--prepare-layer', layer],
      {
        env: nodeEnv,
        timeoutMs: 120000,
      },
    ),
    0,
    'Layer preparation failed',
  )
  // The layer's Vue SFCs resolve the app tsconfig, which `nuxt prepare` generates
  // (ignored .nuxt output in the checkout; git status stays clean).
  assert.equal(
    await run(
      'prepare-app',
      join(checkout, 'apps/farm/node_modules/.bin/nuxt'),
      ['prepare'],
      { cwd: join(checkout, 'apps/farm'), env: nodeEnv, timeoutMs: 300000 },
    ),
    0,
    'App type preparation failed',
  )
  assert.equal(
    await run('build-layer', join(layer, 'node_modules/.bin/nuxt'), ['build'], {
      cwd: layer,
      env: nodeEnv,
      timeoutMs: 900000,
    }),
    0,
    'Layer build failed',
  )
  assert.equal(
    await run(
      'seal-layer',
      process.execPath,
      [harness, '--seal-build', layer],
      {
        env: nodeEnv,
        timeoutMs: 300000,
      },
    ),
    0,
    'Layer seal failed',
  )

  if (camera)
    rtsp = await startRtspCamera({
      checkout,
      workDir,
      project: name + '-rtsp',
      port: camera.port,
      helper: camera.helper,
      ledger,
    })
  for (let attempt = 1; attempt <= runs; attempt++)
    for (const scenario of scenarios) {
      const rowLedger = join(workDir, `${attempt}-${scenario.name}.ledger`)
      const startedAt = performance.now()
      const code = await run(
        `${attempt}-${scenario.name}`,
        process.execPath,
        [harness, '--run'],
        {
          env: {
            ...nodeEnv,
            ...scenario.env,
            ...(scenario.resources?.includes('rtsp-camera') ? rtsp?.env : {}),
            SIGNALLING_HTTPS_DISPOSABLE: 'yes',
            SIGNALLING_HTTPS_PORT: String(dbPort),
            SIGNALLING_HTTPS_LEDGER: rowLedger,
            SIGNALLING_HTTPS_LAYER: layer,
          },
          timeoutMs: 300000,
        },
      )
      const text = [rowLedger, rowLedger + '.rtc-resources.jsonl'].filter(
        existsSync,
      )
      const combined = (
        await Promise.all(text.map((path) => readFile(path, 'utf8')))
      ).join('\n')
      for (const path of [
        rowLedger,
        rowLedger + '.rtc-resources.jsonl',
        rowLedger + '.app-log.txt',
      ])
        if (existsSync(path))
          await copyFile(path, join(evidence, path.slice(workDir.length + 1)))
      const passed =
        code === 0 && scenario.expect.every((line) => combined.includes(line))
      const metric = (name: string) => {
        const match = combined.match(
          new RegExp(`farm-page-${name}-after-ms:(\\d+)`),
        )
        return match ? { [`${name}Ms`]: Number(match[1]) } : {}
      }
      results.push({
        run: attempt,
        scenario: scenario.name,
        passed,
        ms: Math.round(performance.now() - startedAt),
        ...metric('readonly'),
        ...metric('recovered'),
        ...(metric('pause-applied')['pause-appliedMs'] === undefined
          ? {}
          : { pauseAppliedMs: metric('pause-applied')['pause-appliedMs'] }),
      })
      ledger({ result: results.at(-1) })
      if (interrupted) throw new Error('Interrupted')
    }
  assert.ok(
    results.every((result) => result.passed),
    'One or more scenario rows failed',
  )
} catch (error) {
  failure = error
  ledger({
    failure: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
  })
} finally {
  try {
    await rtsp?.stop()
  } catch (error) {
    cleanupFailure ??= error
  }
  try {
    await sql?.end({ timeout: 3 })
  } catch (error) {
    cleanupFailure ??= error
  }
  try {
    // Exact ownership: recover the ID by name if recording was interrupted.
    // A timed-out `docker create` is not cancelled in the daemon and can still
    // finish later, so keep looking for a bounded time after an attempt.
    let owned =
      container ??
      (await docker('inspect', '--format', '{{.Id}}', name).catch(() => ''))
    for (
      let waited = 0;
      !owned && createAttempted && waited < CREATE_SETTLE_MS;
      waited += 2000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      owned = await docker('inspect', '--format', '{{.Id}}', name).catch(
        () => '',
      )
    }
    if (owned) {
      assert.match(owned, /^[a-f0-9]{64}$/)
      assert.equal(
        await docker(
          'inspect',
          '--format',
          '{{index .Config.Labels "org.open3dfarmmanager.rtc-farm-test"}}',
          owned,
        ),
        id,
      )
      // A timed-out `rm` can still finish in the daemon: confirm by state.
      const removal: unknown = await docker('rm', '--force', owned).then(
        () => undefined,
        (error: unknown) => error,
      )
      let present = true
      for (let waited = 0; waited <= CREATE_SETTLE_MS; waited += 2000) {
        present =
          (await docker(
            'ps',
            '-aq',
            '--no-trunc',
            '--filter',
            'id=' + owned,
          )) !== ''
        if (!present) break
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      if (present) throw removal ?? new Error('Owned container remains')
      ledger({
        removed: 'container',
        id: owned,
        ...(removal ? { afterClientTimeout: true } : {}),
      })
    }
  } catch (error) {
    cleanupFailure ??= error
  }
  try {
    // Exact path: the work directory this run created (layer, CA, keys, ledgers).
    await rm(workDir, { recursive: true, force: true })
    ledger({ removed: 'work-directory', path: workDir })
  } catch (error) {
    cleanupFailure ??= error
  }
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
  console.log(
    JSON.stringify({
      result: failure || cleanupFailure ? 'failed' : 'passed',
      results,
      evidence,
      error: failure instanceof Error ? failure.message : undefined,
    }),
  )
}
if (failure) throw failure
if (cleanupFailure) throw cleanupFailure
