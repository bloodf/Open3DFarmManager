// Disposable PostgreSQL fixture for explicit test runners:
// 1. Throwaway local cluster (default) made with initdb + pg_ctl in a temp dir on 127.0.0.1
//    and a free port, removed on exit.
// 2. Existing superuser database URL (OPENFARM_TEST_DATABASE_URL).
// 3. Digest-pinned PostgreSQL 17 Docker container (opt-in via OPENFARM_PG=docker).
//
// Supported PostgreSQL range: PostgreSQL >= 13.
// The OpenFarm migration catalog relies on no features newer than PostgreSQL 13
// (e.g. gen_random_uuid / uuid-ossp, generated columns, standard identity columns,
// and transactional DDL).
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import postgres, { type Sql } from 'postgres'
import {
  catalogThrough,
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from '../../scripts/db/migrations.ts'

const exec = promisify(execFile)

export const POSTGRES_IMAGE_PATTERN =
  /^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/

export type DockerCommand = (...args: string[]) => Promise<string>

export interface PostgresBinaries {
  initdb: string
  pg_ctl: string
  postgres: string
  version: string
  majorVersion: number
}

let cachedBinaries: PostgresBinaries | undefined

/**
 * Searches for PostgreSQL binaries (initdb, pg_ctl, postgres) on PATH, under
 * /usr/lib/postgresql/<version>/bin, or standard macOS Homebrew locations.
 * Fails with a clear message if missing.
 */
export function findPostgresBin(forceRefresh = false): PostgresBinaries {
  if (cachedBinaries && !forceRefresh) return cachedBinaries

  const candidates: string[] = []
  if (process.env.OPENFARM_PG_BIN) {
    candidates.push(process.env.OPENFARM_PG_BIN)
  }
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(':')) {
      if (dir) candidates.push(dir)
    }
  }

  // Linux /usr/lib/postgresql/*/bin
  try {
    const linuxBase = '/usr/lib/postgresql'
    if (existsSync(linuxBase)) {
      const versions = readdirSync(linuxBase)
        .filter((v) => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a))
      for (const v of versions) {
        candidates.push(join(linuxBase, v, 'bin'))
      }
    }
  } catch {}

  for (const dir of candidates) {
    const initdb = join(dir, 'initdb')
    const pg_ctl = join(dir, 'pg_ctl')
    const pg = join(dir, 'postgres')
    if (existsSync(initdb) && existsSync(pg_ctl) && existsSync(pg)) {
      try {
        const out = execFileSync(pg_ctl, ['--version'], {
          encoding: 'utf8',
        }).trim()
        const match = /(\d+)(?:\.\d+)?/.exec(out)
        const majorVersion = match ? Number(match[1]) : 0
        cachedBinaries = {
          initdb,
          pg_ctl,
          postgres: pg,
          version: out,
          majorVersion,
        }
        return cachedBinaries
      } catch {}
    }
  }

  throw new Error(
    'PostgreSQL initdb/pg_ctl not found on PATH or under /usr/lib/postgresql/*/bin. A local PostgreSQL installation (version >= 13) is required to run database suites.',
  )
}

/** Allocates a free ephemeral TCP port on loopback. */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') {
        srv.close(() => reject(new Error('Failed to get free port')))
        return
      }
      const port = address.port
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

export interface DisposablePostgresInput {
  name: string
  labelKey?: string
  labelValue?: string
  port?: number
  ledger?: (value: object) => void
  /**
   * Migration journal state to leave on the fixture database: omitted applies
   * the full catalog, a migration id applies only through that migration,
   * false leaves the fixture database untouched.
   */
  through?: string | false
  postgresArgs?: string[]
  docker?: DockerCommand
  image?: string
}

export interface DisposablePostgresFixture {
  readonly port: number
  readonly container?: string
  readonly dataDir?: string
  readonly tempDir?: string
  readonly logPath?: string
  readonly systemId?: string
  start(): Promise<Sql>
  logs(): Promise<string>
  stop(): Promise<void>
}

export function disposablePostgres(
  input: DisposablePostgresInput,
): DisposablePostgresFixture {
  const { name, ledger = () => {} } = input
  const isDocker = process.env.OPENFARM_PG === 'docker'
  const testDatabaseUrl = process.env.OPENFARM_TEST_DATABASE_URL

  let container: string | undefined
  let sql: Sql | undefined
  let port = input.port ?? 0
  let tempDir: string | undefined
  let dataDir: string | undefined
  let logPath: string | undefined
  let systemId: string | undefined
  let testDbName: string | undefined
  let rootSql: Sql | undefined

  return {
    get port() {
      return port
    },
    get container() {
      return container
    },
    get dataDir() {
      return dataDir
    },
    get tempDir() {
      return tempDir
    },
    get logPath() {
      return logPath
    },
    get systemId() {
      return systemId
    },

    async start() {
      if (isDocker) {
        // Opt-in Docker container branch (OPENFARM_PG=docker)
        const docker = input.docker
        if (!docker) {
          throw new Error(
            'Docker runner function required when OPENFARM_PG=docker',
          )
        }
        const image = input.image
        if (!image) {
          throw new Error('Docker image required when OPENFARM_PG=docker')
        }
        const label = `${input.labelKey ?? 'org.open3dfarmmanager.postgres'}=${input.labelValue ?? name}`
        await docker('image', 'inspect', image)
        ledger({ resource: 'container', name, label, image })
        await docker(
          ...['create', '--name', name, '--label', label, '--pull', 'never'],
          ...[
            '--cpus',
            '2',
            '--memory',
            '2g',
            '--read-only',
            '--cap-drop',
            'ALL',
          ],
          ...['--security-opt', 'no-new-privileges', '--user', 'postgres'],
          ...['--tmpfs', '/var/lib/postgresql/data:rw,mode=1777'],
          ...['--tmpfs', '/var/run/postgresql:rw,mode=1777'],
          ...['--tmpfs', '/tmp:rw,mode=1777'],
          ...['-p', `127.0.0.1:${input.port || ''}:5432`],
          ...['-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture'],
          ...['-e', 'POSTGRES_HOST_AUTH_METHOD=trust'],
          ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
          image,
          ...(input.postgresArgs ?? []),
        )
        container = await docker('inspect', '--format', '{{.Id}}', name)
        assert.match(container, /^[a-f0-9]{64}$/)
        ledger({ resource: 'container-id', id: container })
        await docker('start', container)
        await docker(
          ...['exec', container, 'sh', '-c'],
          'n=0; until pg_isready -h 127.0.0.1 -U fixture -d fixture >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done',
        )
        if (port === 0) {
          const mapping = await docker('port', container, '5432/tcp')
          assert.match(mapping, /^127\.0\.0\.1:[0-9]+$/)
          port = Number(mapping.split(':')[1])
        }
        logPath = '/var/lib/postgresql/data/pgdata/log/postgresql.log'
        sql = postgres({
          host: '127.0.0.1',
          port,
          onnotice: () => {},
          database: 'fixture',
          username: 'fixture',
          password: '',
          ssl: false,
          max: 4,
          connect_timeout: 3,
          connection: { application_name: name, statement_timeout: 10000 },
        })
      } else if (testDatabaseUrl) {
        // Provider: existing superuser URL (OPENFARM_TEST_DATABASE_URL)
        const parsed = new URL(testDatabaseUrl)
        port = Number(parsed.port || 5432)
        rootSql = postgres(testDatabaseUrl, { max: 1, onnotice: () => {} })
        testDbName = `o3dfm_test_${randomBytes(4).toString('hex')}`
        await rootSql.unsafe(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fixture') THEN CREATE ROLE fixture WITH SUPERUSER LOGIN; END IF; END $$;`,
        )
        await rootSql.unsafe(`CREATE DATABASE "${testDbName}" OWNER fixture`)
        ledger({ resource: 'database', name: testDbName, url: testDatabaseUrl })
        sql = postgres({
          host: parsed.hostname,
          port,
          onnotice: () => {},
          database: testDbName,
          username: 'fixture',
          password: '',
          ssl: false,
          max: 4,
          connect_timeout: 3,
          connection: { application_name: name, statement_timeout: 10000 },
        })
      } else {
        // Default provider: throwaway cluster made with initdb + pg_ctl on loopback
        const bins = findPostgresBin()
        if (port === 0 || !port) {
          port = await getFreePort()
        }
        tempDir = await mkdtemp(join(tmpdir(), 'o3dfm-pg-'))
        dataDir = join(tempDir, 'data')
        const socketDir = join(tempDir, 's')
        await mkdir(socketDir, { recursive: true, mode: 0o700 })
        const logDir = join(dataDir, 'log')
        logPath = join(logDir, 'postgresql.log')
        const pgCtlLog = join(tempDir, 'pg_ctl.log')

        ledger({ resource: 'cluster', name, tempDir, port })

        try {
          await exec(bins.initdb, [
            '-D',
            dataDir,
            '-U',
            'fixture',
            '--auth-local=trust',
            '--auth-host=trust',
            '--no-instructions',
            '--no-locale',
            '-E',
            'UTF-8',
          ])

          // Configure high-performance test settings and logging
          await appendFile(
            join(dataDir, 'postgresql.conf'),
            `
fsync = off
synchronous_commit = off
full_page_writes = off
logging_collector = on
log_destination = 'stderr'
log_directory = 'log'
log_filename = 'postgresql.log'
log_line_prefix = '%m [%p] '
listen_addresses = '127.0.0.1'
timezone = 'UTC'
log_timezone = 'UTC'
`,
          )

          // Extra args if any: parse -c key=val and append to postgresql.conf
          const remainingOpts: string[] = []
          if (input.postgresArgs && input.postgresArgs.length > 0) {
            for (let i = 0; i < input.postgresArgs.length; i++) {
              const arg = input.postgresArgs[i]
              if (arg === '-c' && input.postgresArgs[i + 1]) {
                const setting = input.postgresArgs[i + 1]
                const eqIdx = setting.indexOf('=')
                if (eqIdx !== -1) {
                  const key = setting.slice(0, eqIdx).trim()
                  const val = setting.slice(eqIdx + 1)
                  await appendFile(
                    join(dataDir, 'postgresql.conf'),
                    `${key} = '${val}'\n`,
                  )
                }
                i++
              } else {
                remainingOpts.push(arg)
              }
            }
          }

          const pgOpts = [
            `-p ${port}`,
            `-h 127.0.0.1`,
            `-k ${socketDir}`,
            ...remainingOpts,
          ].join(' ')

          await exec(bins.pg_ctl, [
            '-D',
            dataDir,
            '-o',
            pgOpts,
            '-l',
            pgCtlLog,
            'start',
          ])

          // Bootstrap fixture database
          const bootstrap = postgres({
            host: '127.0.0.1',
            port,
            onnotice: () => {},
            database: 'postgres',
            username: 'fixture',
            password: '',
            ssl: false,
            max: 1,
            connect_timeout: 5,
          })
          await bootstrap`CREATE DATABASE fixture OWNER fixture;`
          await bootstrap.end()

          sql = postgres({
            host: '127.0.0.1',
            port,
            onnotice: () => {},
            database: 'fixture',
            username: 'fixture',
            password: '',
            ssl: false,
            max: 4,
            connect_timeout: 3,
            connection: { application_name: name, statement_timeout: 10000 },
          })
        } catch (startupErr) {
          // If startup failed, ensure clean termination and data dir removal
          if (dataDir && existsSync(dataDir)) {
            try {
              await exec(bins.pg_ctl, [
                '-D',
                dataDir,
                '-m',
                'immediate',
                'stop',
              ])
            } catch {}
          }
          if (tempDir && existsSync(tempDir)) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => {})
          }
          throw startupErr
        }
      }

      try {
        assert.equal(
          (await sql`SELECT to_regnamespace('farm') AS n`)[0]?.n,
          null,
          'fresh task-owned cluster only',
        )

        const versionRow = await sql`SHOW server_version`
        const serverVersion = String(versionRow[0]?.server_version ?? '')
        const majorVersion = parseInt(serverVersion, 10)
        assert.ok(
          !Number.isNaN(majorVersion) && majorVersion >= 13,
          `PostgreSQL version ${serverVersion} is not supported; migrations require PostgreSQL >= 13`,
        )

        const sysIdRow =
          await sql`SELECT system_identifier::text AS id FROM pg_control_system()`
        systemId = String(sysIdRow[0]?.id ?? '')

        if (input.through !== undefined) {
          if (input.through === false) return sql
          const prefix = catalogThrough(
            await loadMigrationCatalog(),
            input.through,
          )
          await runMigrations(sql, prefix, { kind: 'up' })
          const prefixJournal =
            await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
          assert.equal(
            validateMigrationHistory(prefix, [...prefixJournal]),
            prefix.length,
          )
          return sql
        }
        const catalog = await loadMigrationCatalog()
        await runMigrations(sql, catalog, { kind: 'up' })
        const journal =
          await sql`SELECT position,id,checksum FROM public.open3dfarm_migrations ORDER BY position`
        assert.equal(
          validateMigrationHistory(catalog, [...journal]),
          catalog.length,
        )
        return sql
      } catch (err) {
        await this.stop().catch(() => {})
        throw err
      }
    },

    async logs() {
      if (isDocker && container) {
        return input.docker
          ? await input.docker('logs', '--tail', '200', container).catch(String)
          : ''
      }
      if (logPath && existsSync(logPath)) {
        try {
          const content = await readFile(logPath, 'utf8')
          return content.slice(-10000)
        } catch {}
      }
      return ''
    },

    async stop() {
      let failure: unknown
      try {
        await sql?.end({ timeout: 3 })
      } catch (error) {
        failure = error
      }
      try {
        if (isDocker) {
          const docker = input.docker
          if (docker) {
            const owned =
              container ??
              (await docker('inspect', '--format', '{{.Id}}', name).catch(
                () => '',
              ))
            if (owned) {
              assert.equal(
                await docker(
                  ...['inspect', '--format'],
                  `{{index .Config.Labels "${input.labelKey ?? 'org.open3dfarmmanager.postgres'}"}} {{.Name}}`,
                  owned,
                ),
                `${input.labelValue ?? name} /${name}`,
              )
              await docker('rm', '-f', owned)
              assert.equal(
                await docker('ps', '-aq', '--filter', 'id=' + owned),
                '',
              )
              ledger({ removed: 'container', id: owned })
            }
          }
        } else if (testDatabaseUrl && rootSql) {
          if (testDbName) {
            await rootSql.unsafe(`DROP DATABASE IF EXISTS "${testDbName}"`)
            ledger({ removed: 'database', name: testDbName })
          }
          await rootSql.end()
        } else {
          // Local cluster: stop pg_ctl and remove temp data directory
          if (dataDir && existsSync(dataDir)) {
            const bins = findPostgresBin()
            try {
              await exec(bins.pg_ctl, [
                '-D',
                dataDir,
                '-m',
                'immediate',
                'stop',
              ])
            } catch {}
          }
          if (tempDir && existsSync(tempDir)) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => {})
            ledger({ removed: 'cluster', tempDir })
          }
        }
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
    },
  }
}
