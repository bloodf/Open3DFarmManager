// npm run test:postgres: the migration round trip (up/down/up, 0001..latest)
// followed by every scripts/test-postgres-*.ts suite, each on its own
// disposable PostgreSQL 17 fixture, with a summary that names failing suites.
// Each fixture uses a label-verified, digest-pinned container; no image is pulled.
// Never sends printer commands or changes pre-existing servers.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readdir, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import postgres, { type Sql } from 'postgres'
import {
  POSTGRES_IMAGE_PATTERN,
  disposablePostgres,
  findPostgresBin,
} from '../tests/helpers/disposable-postgres.ts'
import { testPostgresMigrations } from '../tests/helpers/postgres-migrations-integration.ts'

const exec = promisify(execFile)

/** Migration journal state a job expects on its fixture: the full catalog, none (suite applies its own), a self-contained suite manages its own container, or an exact migration id prefix. */
export type MigrationState = 'full' | 'none' | 'self' | (string & {})

export interface FixtureContext {
  port: number
  url: string
  systemId: string
  image?: string | undefined
  logPath?: string | undefined
}

export interface PgSuiteContract {
  migrations: MigrationState
  /** Suites that connect to the runner-managed fixture as fixture@127.0.0.1. */
  fixture?: { port?: string; admitted: string }
  /** Suites that start and remove their own labelled Docker container. */
  selfContained?: { admitted: string; image: string }
  /** Additional environment derived from the started fixture. */
  extra?: (ctx: FixtureContext) => Record<string, string>
}

const PAUSE_AUTHORITY_SERVER_LOG =
  '/var/lib/postgresql/data/pgdata/log/postgresql.log'

/** Every discovered suite must have a contract; sort order is the run order. */
export const PG_SUITE_CONTRACTS: Record<string, PgSuiteContract> = {
  'test-postgres-atomic-telemetry.ts': {
    migrations: 'none',
    fixture: {
      port: 'ATOMIC_TELEMETRY_SYNTHETIC_TEST_PORT',
      admitted: 'ATOMIC_TELEMETRY_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-auth.ts': {
    migrations: 'full',
    fixture: {
      port: 'AUTHORIZATION_SYNTHETIC_TEST_PORT',
      admitted: 'AUTHORIZATION_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-browser-device-http.ts': {
    migrations: 'full',
    fixture: {
      port: 'BROWSER_DEVICE_HTTP_SYNTHETIC_TEST_PORT',
      admitted: 'BROWSER_DEVICE_HTTP_TEST_DISPOSABLE',
    },
  },
  'test-postgres-browser-device-registry.ts': {
    migrations: 'full',
    fixture: {
      port: 'BROWSER_REGISTRY_SYNTHETIC_TEST_PORT',
      admitted: 'BROWSER_REGISTRY_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-connector-inventory.ts': {
    migrations: 'full',
    fixture: {
      port: 'INVENTORY_SYNTHETIC_TEST_PORT',
      admitted: 'INVENTORY_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-connector-revocation.ts': {
    migrations: 'full',
    fixture: {
      port: 'REVOCATION_SYNTHETIC_TEST_PORT',
      admitted: 'REVOCATION_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-credential-acceptance.ts': {
    migrations: 'full',
    fixture: {
      port: 'CREDENTIAL_ACCEPTANCE_SYNTHETIC_TEST_PORT',
      admitted: 'CREDENTIAL_ACCEPTANCE_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-credential-issuance.ts': {
    migrations: 'full',
    fixture: {
      port: 'CREDENTIAL_SYNTHETIC_TEST_PORT',
      admitted: 'CREDENTIAL_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-credential-renewal.ts': {
    migrations: 'self',
    selfContained: {
      admitted: 'RENEWAL_TEST_ADMITTED',
      image: 'RENEWAL_TEST_IMAGE',
    },
  },
  'test-postgres-credential-successors.ts': {
    migrations: 'self',
    selfContained: {
      admitted: 'SUCCESSOR_TEST_ADMITTED',
      image: 'SUCCESSOR_TEST_IMAGE',
    },
  },
  'test-postgres-cross-farm-http.ts': {
    migrations: 'full',
    fixture: {
      port: 'CROSS_FARM_HTTP_SYNTHETIC_TEST_PORT',
      admitted: 'CROSS_FARM_HTTP_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-enrollment.ts': {
    migrations: 'none',
    fixture: {
      port: 'ENROLLMENT_SYNTHETIC_TEST_PORT',
      admitted: 'ENROLLMENT_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-integration-apps.ts': {
    migrations: 'full',
    fixture: {
      port: 'INTEGRATION_APPS_SYNTHETIC_TEST_PORT',
      admitted: 'INTEGRATION_APPS_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-integration-delivery.ts': {
    migrations: 'full',
    fixture: {
      port: 'INTEGRATION_DELIVERY_SYNTHETIC_TEST_PORT',
      admitted: 'INTEGRATION_DELIVERY_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-integration-approval.ts': {
    migrations: 'full',
    fixture: {
      port: 'INTEGRATION_APPROVAL_SYNTHETIC_TEST_PORT',
      admitted: 'INTEGRATION_APPROVAL_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-integration-jobs.ts': {
    migrations: 'full',
    fixture: {
      port: 'INTEGRATION_JOBS_SYNTHETIC_TEST_PORT',
      admitted: 'INTEGRATION_JOBS_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-integration-read.ts': {
    migrations: 'full',
    fixture: {
      port: 'INTEGRATION_READ_SYNTHETIC_TEST_PORT',
      admitted: 'INTEGRATION_READ_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-integration-webhooks.ts': {
    migrations: 'full',
    fixture: {
      port: 'WEBHOOKS_SYNTHETIC_TEST_PORT',
      admitted: 'WEBHOOKS_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-library.ts': {
    migrations: 'full',
    fixture: {
      port: 'LIBRARY_SYNTHETIC_TEST_PORT',
      admitted: 'LIBRARY_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-members.ts': {
    migrations: 'full',
    fixture: {
      port: 'MEMBERS_SYNTHETIC_TEST_PORT',
      admitted: 'MEMBERS_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-pairing.ts': {
    migrations: 'full',
    fixture: {
      port: 'PAIRING_SYNTHETIC_TEST_PORT',
      admitted: 'PAIRING_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-password-reset.ts': {
    migrations: 'full',
    fixture: {
      port: 'PASSWORD_RESET_SYNTHETIC_TEST_PORT',
      admitted: 'PASSWORD_RESET_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-pause-authority.ts': {
    migrations: '0018_pause_authority',
    fixture: {
      port: 'PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT',
      admitted: 'PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE',
    },
    extra: (ctx) => ({
      PAUSE_AUTHORITY_SYNTHETIC_SERVER_LOG:
        ctx.logPath ?? PAUSE_AUTHORITY_SERVER_LOG,
    }),
  },
  'test-postgres-pause-negotiation.ts': {
    migrations: 'full',
    fixture: {
      port: 'PAUSE_NEGOTIATION_TEST_PORT',
      admitted: 'PAUSE_NEGOTIATION_TEST_DISPOSABLE',
    },
  },
  'test-postgres-printer-ownership.ts': {
    migrations: '0015_printer_ownership',
    fixture: {
      port: 'PRINTER_OWNERSHIP_SYNTHETIC_TEST_PORT',
      admitted: 'PRINTER_OWNERSHIP_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-registration.ts': {
    migrations: 'full',
    fixture: {
      port: 'REGISTRATION_SYNTHETIC_TEST_PORT',
      admitted: 'REGISTRATION_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-session-clock.ts': {
    migrations: 'full',
    fixture: {
      port: 'SESSION_CLOCK_DISPOSABLE_PORT',
      admitted: 'SESSION_CLOCK_DISPOSABLE',
    },
    extra: ({ systemId }) => ({ SESSION_CLOCK_DISPOSABLE_SYSTEM_ID: systemId }),
  },
  'test-postgres-sessions.ts': {
    migrations: 'none',
    fixture: {
      port: 'SESSIONS_SYNTHETIC_TEST_PORT',
      admitted: 'SESSIONS_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-signalling-authorization.ts': {
    migrations: '0019_signalling_assignment_scope',
    fixture: {
      port: 'SIGNALLING_READER_SYNTHETIC_TEST_PORT',
      admitted: 'SIGNALLING_READER_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-signalling-successors.ts': {
    migrations: 'self',
    selfContained: {
      admitted: 'SIGNALLING_SUCCESSOR_TEST_ADMITTED',
      image: 'SIGNALLING_SUCCESSOR_TEST_IMAGE',
    },
  },
  'test-postgres-telemetry-prune.ts': {
    migrations: 'full',
    fixture: {
      port: 'TELEMETRY_PRUNE_SYNTHETIC_TEST_PORT',
      admitted: 'TELEMETRY_PRUNE_SYNTHETIC_TEST_DISPOSABLE',
    },
  },
  'test-postgres-latest-state.ts': {
    migrations: 'full',
    fixture: {
      port: 'LATEST_STATE_SYNTHETIC_TEST_PORT',
      admitted: 'LATEST_STATE_TEST_DISPOSABLE',
    },
  },
  'test-postgres-startup-gating.ts': {
    migrations: 'none',
    fixture: { admitted: 'STARTUP_GATING_DISPOSABLE' },
    extra: ({ url }) => ({ STARTUP_GATING_DATABASE_URL: url }),
  },
}

/**
 * Node test files the runner also runs after the suites. They drive the real
 * handlers over in-process fakes, so they take no fixture of their own; naming
 * them here keeps them in `npm run test:postgres` and in its summary.
 */
export const PG_NODE_TEST_FILES: readonly string[] = [
  'tests/unit/api-v1-contract.test.ts',
]

/** Round trip on a fresh fixture, before every suite. */
export const MIGRATION_ROUND_TRIP = 'migration-round-trip'
export const MIGRATION_PREFIX_ROUND_TRIP = 'migration-prefix-round-trip'

/** Run order: round trip first, then every discovered suite sorted. */
export function planJobs(suites: readonly string[]): string[] {
  return [MIGRATION_ROUND_TRIP, MIGRATION_PREFIX_ROUND_TRIP, ...suites]
}

export async function discoverPostgresSuites(
  scriptsDir: string | URL,
): Promise<string[]> {
  const entries = await readdir(scriptsDir, { withFileTypes: true })
  return entries
    .filter(
      (entry) => entry.isFile() && /^test-postgres-.+\.ts$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
}

export interface SuiteResult {
  name: string
  ok: boolean
  ms: number
  error?: string
}

function firstLine(cause: unknown): string {
  const text =
    cause instanceof Error
      ? (cause.message.split('\n').find((line) => line.trim()) ?? cause.message)
      : String(cause)
  return text.length > 300 ? text.slice(0, 297) + '…' : text
}

/**
 * Runs jobs strictly sequentially: each started fixture is stopped before the
 * next job starts, stops run even when the job fails, and a stop failure marks
 * the job failed. Results preserve execution order and name failed jobs.
 */
export async function runSuites(deps: {
  order: readonly string[]
  start: (name: string) => Promise<unknown>
  invoke: (name: string, handle: unknown) => Promise<void>
  stop: (name: string, handle: unknown) => Promise<void>
}): Promise<SuiteResult[]> {
  const results: SuiteResult[] = []
  for (const name of deps.order) {
    const startedAt = performance.now()
    let handle: unknown
    let started = false
    let ok = true
    let error: string | undefined
    try {
      handle = await deps.start(name)
      started = true
    } catch (cause) {
      ok = false
      error = 'fixture: ' + firstLine(cause)
    }
    if (started) {
      try {
        await deps.invoke(name, handle)
      } catch (cause) {
        ok = false
        error = firstLine(cause)
      }
      try {
        await deps.stop(name, handle)
      } catch (cause) {
        ok = false
        error = (error ? error + '; cleanup: ' : 'cleanup: ') + firstLine(cause)
      }
    }
    results.push({
      name,
      ok,
      ms: Math.round(performance.now() - startedAt),
      ...(error ? { error } : {}),
    })
  }
  return results
}

/** Human summary: one line per job plus counts and the failing job names. */
export function formatSummary(results: readonly SuiteResult[]): string {
  const failed = results.filter((result) => !result.ok)
  const lines = results.map(
    (result) =>
      `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${(result.ms / 1000).toFixed(1)}s)` +
      (result.error ? ` — ${result.error}` : ''),
  )
  lines.push(
    `  ${results.length} jobs, ${results.length - failed.length} passed, ${failed.length} failed`,
  )
  if (failed.length)
    lines.push(`  failing: ${failed.map((result) => result.name).join(', ')}`)
  return lines.join('\n')
}

// --- real wiring (entry point only; the functions above stay offline-testable) ---

const USAGE =
  'Run with POSTGRES_TEST_IMAGE=<digest-pinned PostgreSQL 17 image already present locally; never pulled> ' +
  'to start one disposable labelled container per fixture. ' +
  'Optional POSTGRES_TEST_SUITES=test-postgres-a.ts,test-postgres-b.ts reruns a subset; ' +
  '`--only <text>` keeps suites whose name contains the text (the migration round trips always run).'

const SUITE_TIMEOUT_MS = 600_000
const RUNNER_LABEL = 'org.open3dfarmmanager.postgres-runner'

interface JobHandle {
  cleanup?: () => Promise<void>
  sql?: Sql
  env?: NodeJS.ProcessEnv
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const onlyFlag =
    args.length === 2 && args[0] === '--only' && args[1] ? args[1] : undefined
  if (args.length !== 0 && onlyFlag === undefined) throw new Error(USAGE)
  const env = process.env
  const isDocker = env.OPENFARM_PG === 'docker'
  let image: string | undefined
  let docker: ((...args: string[]) => Promise<string>) | undefined
  if (isDocker) {
    image =
      env.POSTGRES_TEST_IMAGE ??
      (await exec(
        'docker',
        [
          'image',
          'inspect',
          'postgres:17',
          '--format',
          '{{index .RepoDigests 0}}',
        ],
        { timeout: 60000 },
      ).then(({ stdout }) =>
        stdout.trim().replace(/^postgres@/, 'postgres:17@'),
      ))
    if (!image || !POSTGRES_IMAGE_PATTERN.test(image)) throw new Error(USAGE)

    docker = async (...args: string[]): Promise<string> =>
      (
        await exec('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })
      ).stdout.trim()

    const endpoint =
      env.DOCKER_HOST ??
      (await docker(
        'context',
        'inspect',
        '--format',
        '{{.Endpoints.docker.Host}}',
      ))
    assert.match(
      endpoint,
      /^unix:\/\//,
      'Only a local Docker daemon is allowed',
    )
  } else if (!env.OPENFARM_TEST_DATABASE_URL) {
    const bins = findPostgresBin()
    console.log(`[test-postgres] using PostgreSQL cluster with ${bins.version}`)
  }

  const scriptsDir = new URL('./', import.meta.url)
  const repoRoot = new URL('../', import.meta.url)
  const suites = await discoverPostgresSuites(scriptsDir)
  for (const suite of suites)
    if (!PG_SUITE_CONTRACTS[suite])
      throw new Error(`Missing PG_SUITE_CONTRACTS entry for ${suite}`)
  const only = env.POSTGRES_TEST_SUITES?.split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (only) {
    const unknown = only.filter(
      (name) => !suites.includes(name) && !PG_NODE_TEST_FILES.includes(name),
    )
    if (unknown.length)
      throw new Error(
        `Unknown POSTGRES_TEST_SUITES entries: ${unknown.join(', ')}`,
      )
  }
  const skipped: string[] = []
  const runnable = suites.filter(
    (suite) =>
      (!only || only.includes(suite)) &&
      (onlyFlag === undefined || suite.includes(onlyFlag)),
  )
  const nodeTestFiles = PG_NODE_TEST_FILES.filter(
    (file) =>
      (!only || only.includes(file)) &&
      (onlyFlag === undefined || file.includes(onlyFlag)),
  )
  if (onlyFlag !== undefined && !runnable.length && !nodeTestFiles.length)
    throw new Error(`No suite matches --only ${onlyFlag}`)
  const order = [...planJobs(runnable), ...nodeTestFiles]

  const id = randomUUID()
  const evidenceDir = join(homedir(), '.local/state/o3dfm/postgres-runner', id)
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  const ledgerPath = join(evidenceDir, 'ledger.jsonl')
  const ledger = (value: object) =>
    appendFileSync(ledgerPath, JSON.stringify(value) + '\n', { mode: 0o600 })
  const baseline = await statfs(process.cwd(), { bigint: true })
  ledger({
    event: 'baseline',
    image: image ?? null,
    diskAvailableBytes: String(baseline.bavail * baseline.bsize),
    suites: order,
    skipped,
  })

  let current: {
    kill?: (() => void) | undefined
    cleanup?: (() => Promise<void>) | undefined
  } = {}
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      try {
        current.kill?.()
      } catch {
        /* best effort */
      }
      const cleanup = current.cleanup
      if (cleanup)
        void cleanup()
          .catch(() => {})
          .finally(() => process.exit(130))
      else process.exit(130)
    })
  }

  const start = async (name: string): Promise<JobHandle> => {
    if (name === MIGRATION_ROUND_TRIP || name === MIGRATION_PREFIX_ROUND_TRIP) {
      // The round trip drives the migrations itself on a pristine fixture.
      const handle = await startFixture(name, 'none')
      return handle
    }
    if (PG_NODE_TEST_FILES.includes(name)) return { env }
    const contract = PG_SUITE_CONTRACTS[name]
    if (!contract) throw new Error(`Missing contract for ${name}`)
    if (contract.selfContained) {
      const additions: Record<string, string> = {
        [contract.selfContained.admitted]: 'yes',
      }
      if (image) additions[contract.selfContained.image] = image
      return { env: { ...env, ...additions } }
    }
    return startFixture(name, contract.migrations)
  }

  async function startFixture(
    name: string,
    state: MigrationState,
  ): Promise<JobHandle> {
    const database = disposablePostgres({
      name: `o3dfm-pg-runner-${id.slice(0, 8)}-${name.replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      labelKey: RUNNER_LABEL,
      labelValue: id,
      port: 0,
      ledger,
      ...(isDocker ? { docker, image } : {}),
      ...(name === 'test-postgres-pause-authority.ts'
        ? {
            postgresArgs: [
              '-c',
              'logging_collector=on',
              '-c',
              'log_filename=postgresql.log',
              '-c',
              'log_line_prefix=%m [%p] ',
            ],
          }
        : {}),
      ...(state === 'full'
        ? {}
        : { through: state === 'none' ? false : state }),
    })
    let sql: Sql
    try {
      sql = await database.start()
    } catch (cause) {
      try {
        await database.stop()
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          `Fixture startup and cleanup failed: ${firstLine(cleanup)}`,
        )
      }
      throw cause
    }
    try {
      const port = database.port
      const systemId =
        database.systemId ??
        String(
          (
            await sql`SELECT system_identifier::text AS id FROM pg_control_system()`
          )[0]?.id ?? '',
        )
      const ctx: FixtureContext = {
        port,
        url: `postgres://fixture@127.0.0.1:${port}/fixture`,
        systemId,
        image,
        logPath: database.logPath,
      }
      const contract = PG_SUITE_CONTRACTS[name]
      const additions: Record<string, string> = {}
      if (contract?.fixture?.port)
        additions[contract.fixture.port] = String(port)
      if (contract?.fixture?.admitted)
        additions[contract.fixture.admitted] = 'yes'
      if (contract?.extra) Object.assign(additions, contract.extra(ctx))
      ledger({ event: 'fixture-ready', job: name, port, state })
      const handle: JobHandle = {
        sql,
        env: { ...env, ...additions },
        cleanup: () => database.stop(),
      }
      current.cleanup = handle.cleanup
      return handle
    } catch (cause) {
      await database.stop()
      throw cause
    }
  }

  const invoke = async (name: string, handle: unknown): Promise<void> => {
    const job = handle as JobHandle
    if (name === MIGRATION_ROUND_TRIP || name === MIGRATION_PREFIX_ROUND_TRIP) {
      if (!job.sql) throw new Error('Round trip fixture missing')
      const checks = await testPostgresMigrations(
        job.sql,
        name === MIGRATION_PREFIX_ROUND_TRIP ? '0025_schema_reader' : undefined,
      )
      console.log(
        JSON.stringify({ result: 'passed', job: name, checks: checks.length }),
      )
      return
    }
    if (!job.env) throw new Error(`No environment for ${name}`)
    const logPath = join(evidenceDir, name.replace(/[^\w.-]+/g, '_') + '.log')
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        PG_NODE_TEST_FILES.includes(name)
          ? ['--test', name]
          : [join(new URL(scriptsDir).pathname, name)],
        {
          env: job.env,
          cwd: new URL(repoRoot).pathname,
          timeout: SUITE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          current.kill = undefined
          const output = stdout + stderr
          writeFile(logPath, output, { mode: 0o600 }).catch(() => {})
          if (error) {
            const lines = output.trimEnd().split('\n')
            const tail =
              lines.find((line) =>
                /^(?:AssertionError|Error|TypeError|SyntaxError| FAIL)\b/.test(
                  line,
                ),
              ) ?? lines.slice(-4).join('\n')
            reject(
              new Error(
                tail ||
                  (error instanceof Error ? error.message : String(error)),
              ),
            )
          } else resolve()
        },
      )
      current.kill = () => child.kill('SIGKILL')
    })
  }

  const stop = async (_name: string, handle: unknown): Promise<void> => {
    const job = handle as JobHandle
    await job.cleanup?.()
    current = {}
  }

  console.log(
    `[test-postgres] ${order.length} jobs (${runnable.length} suites + ${nodeTestFiles.length} node test files + 2 migration checks)` +
      (skipped.length
        ? `; skipped without Docker image: ${skipped.join(', ')}`
        : ''),
  )
  const startedAt = performance.now()
  const results = await runSuites({ order, start, invoke, stop })
  const summary = formatSummary(results)
  console.log(summary)
  console.log(
    `[test-postgres] evidence: ${evidenceDir} (total ${((performance.now() - startedAt) / 1000).toFixed(1)}s)`,
  )
  await writeFile(
    join(evidenceDir, 'summary.json'),
    JSON.stringify(
      {
        id,
        image: image ?? null,
        skipped,
        results,
        summary,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  ledger({ event: 'finished', failures: results.filter((r) => !r.ok).length })
  return results.some((result) => !result.ok) ? 1 : 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    },
  )
}
