// One-command real-RTC farm-page acceptance (issues #8/#9; Phase 0 base).
// Disposable digest-pinned PostgreSQL 17 (never pulled), throwaway TLS CA and
// keys in a private work directory, sealed built farm server over HTTPS, real
// native Connector (node-datachannel) with a loopback fake Moonraker, and
// Playwright Chromium on the real farm page. Never contacts a printer, never
// accepts a database URL or an existing container. See
// docs/RTC-FARM-ACCEPTANCE-CHECKPOINT.md.
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, existsSync } from 'node:fs'
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
const prefix = env.RTC_FARM_TEST_NAME_PREFIX ?? 'o3dfm-rtc-farm'
if (!/^o3dfm-[a-z0-9-]{1,40}$/.test(prefix))
  throw new Error('Invalid RTC farm test name prefix')
const id = randomUUID()
const name = prefix + '-' + id
const label = 'org.open3dfarmmanager.rtc-farm-test=' + id
const workDir = join(workRoot, id)
const evidence = join(homedir(), '.local/state/o3dfm/rtc-farm-tests', id)
await mkdir(workDir, { recursive: true, mode: 0o700 })
await mkdir(evidence, { recursive: true, mode: 0o700 })
const ledgerPath = join(evidence, 'resources.jsonl')
const ledger = (value: object) =>
  appendFileSync(ledgerPath, JSON.stringify(value) + '\n', { mode: 0o600 })
ledger({ resource: 'work-directory', path: workDir, dbPort })

const docker = async (...args: string[]) =>
  (
    await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
  ).stdout.trim()

// Signals interrupt the current child group; cleanup always runs in finally.
let interrupted = false
let current: ChildProcess | undefined
const interrupt = () => {
  interrupted = true
  if (current?.pid)
    try {
      process.kill(-current.pid, 'SIGTERM')
    } catch {
      /* already exited */
    }
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

/** Runs one owned process group; output goes to a bounded evidence log. */
async function run(
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<number> {
  if (interrupted) throw new Error('Interrupted')
  const log = createWriteStream(join(evidence, label + '.log'), { mode: 0o600 })
  const child = spawn(command, args, {
    cwd: options.cwd ?? checkout,
    env: options.env ?? env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  current = child
  ledger({ resource: 'process-group', label, pid: child.pid })
  child.stdout?.pipe(log, { end: false })
  child.stderr?.pipe(log, { end: false })
  const timer = setTimeout(interrupt, options.timeoutMs)
  try {
    const [code, signal] = await once(child, 'exit')
    return signal ? 128 : (code as number)
  } finally {
    clearTimeout(timer)
    current = undefined
    // A surviving group after its leader exited is owned and must not linger.
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* group gone */
    }
    log.end()
  }
}

let container: string | undefined
let sql: ReturnType<typeof postgres> | undefined
let failure: unknown
let cleanupFailure: unknown
const results: {
  run: number
  scenario: string
  passed: boolean
  ms: number
}[] = []
try {
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
  const nodeEnv = { ...env, TMPDIR: workDir }
  delete nodeEnv.NODE_TLS_REJECT_UNAUTHORIZED
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
      results.push({
        run: attempt,
        scenario: scenario.name,
        passed,
        ms: Math.round(performance.now() - startedAt),
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
    await sql?.end({ timeout: 3 })
  } catch (error) {
    cleanupFailure = error
  }
  try {
    // Exact ownership: recover the ID by name if recording was interrupted.
    const owned =
      container ??
      (await docker('inspect', '--format', '{{.Id}}', name).catch(() => ''))
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
      await docker('rm', '--force', owned)
      ledger({ removed: 'container', id: owned })
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
