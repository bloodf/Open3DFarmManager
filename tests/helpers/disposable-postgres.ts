// Disposable digest-pinned PostgreSQL 17 for explicit test runners: read-only
// root, tmpfs data, all capabilities dropped, loopback port, migrated to the
// current catalog. Never pulls an image and removes only its own container,
// verified by ID, name and label.
import assert from 'node:assert/strict'
import postgres from 'postgres'
import {
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from '../../scripts/db/migrations.ts'

export const POSTGRES_IMAGE_PATTERN =
  /^postgres:17(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/

type Docker = (...args: string[]) => Promise<string>

export function disposablePostgres(input: {
  docker: Docker
  image: string
  name: string
  labelKey: string
  labelValue: string
  port: number
  ledger: (value: object) => void
}) {
  const { docker, name, ledger } = input
  const label = `${input.labelKey}=${input.labelValue}`
  let container: string | undefined
  let sql: ReturnType<typeof postgres> | undefined
  return {
    get container() {
      return container
    },
    async start() {
      // Fails rather than pulling: image ownership and deletion remain with its owner.
      await docker('image', 'inspect', input.image)
      ledger({ resource: 'container', name, label, image: input.image })
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
        ...['-p', `127.0.0.1:${input.port}:5432`],
        ...['-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_DB=fixture'],
        ...['-e', 'POSTGRES_HOST_AUTH_METHOD=trust'],
        ...['-e', 'PGDATA=/var/lib/postgresql/data/pgdata'],
        input.image,
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
      sql = postgres({
        host: '127.0.0.1',
        port: input.port,
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
      assert.equal(
        validateMigrationHistory(catalog, [...journal]),
        catalog.length,
      )
      return sql
    },
    async logs() {
      return container
        ? await docker('logs', '--tail', '200', container).catch(String)
        : ''
    },
    /** Closes the admin pool, then removes only the verified owned container. */
    async stop() {
      let failure: unknown
      try {
        await sql?.end({ timeout: 3 })
      } catch (error) {
        failure = error
      }
      try {
        const owned =
          container ??
          (await docker('inspect', '--format', '{{.Id}}', name).catch(() => ''))
        if (owned) {
          assert.equal(
            await docker(
              ...['inspect', '--format'],
              `{{index .Config.Labels "${input.labelKey}"}} {{.Name}}`,
              owned,
            ),
            `${input.labelValue} /${name}`,
          )
          await docker('rm', '-f', owned)
          assert.equal(await docker('ps', '-aq', '--filter', 'id=' + owned), '')
          ledger({ removed: 'container', id: owned })
        }
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
    },
  }
}
