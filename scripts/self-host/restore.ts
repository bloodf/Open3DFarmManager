import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { copyConnectorConfig } from '../connector-config-backup.ts'
import {
  loadMigrationCatalog,
  validateMigrationHistory,
} from '../db/migrations.ts'

/** Run with the Connector stopped. Leave its command journals in place. */
export function fenceConnector(directory: string) {
  const fd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const stat = fstatSync(fd)
    if (stat.uid !== process.getuid?.() || stat.mode & 0o022)
      throw new Error(
        'Connector state directory must be operator-owned and protected',
      )
    const epoch = randomUUID()
    const temporary = join(directory, '.restore-' + epoch)
    const marker = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(marker, epoch)
      fsyncSync(marker)
      closeSync(marker)
    } catch (error) {
      closeSync(marker)
      unlinkSync(temporary)
      throw error
    }
    try {
      renameSync(temporary, join(directory, 'trusted-keys.epoch'))
    } catch (error) {
      unlinkSync(temporary)
      throw error
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export async function restore(
  container: string,
  database: string,
  dump: string,
  kind: 'collector' | 'provisioning',
  backup: string,
  target: string,
  stateDirectories: readonly string[],
) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    database === 'postgres' ||
    database.startsWith('template')
  )
    throw new Error('Use a new dedicated database name')
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container) ||
    !stateDirectories.length
  )
    throw new Error(
      'Provide the PostgreSQL container and Connector state directories',
    )
  const catalog = await loadMigrationCatalog()
  function run(args: string[], input?: number) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        container,
        'sh',
        '-c',
        'exec "$0" -U "${POSTGRES_USER:-postgres}" "$@"',
        ...args,
      ],
      { encoding: 'utf8', stdio: [input ?? 'ignore', 'pipe', 'inherit'] },
    )
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(args[0] + ' failed')
    return result.stdout
  }
  function sql(db: string, statement: string) {
    return run([
      'psql',
      '-XqAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      db,
      '-c',
      statement,
    ])
  }
  const archive = openSync(
    dump,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    if (!fstatSync(archive).isFile())
      throw new Error('Dump must be a regular file')
    sql(
      'postgres',
      `CREATE DATABASE "${database}" WITH TEMPLATE template0 CONNECTION LIMIT 0`,
    )
    try {
      run(
        [
          'pg_restore',
          '-Fc',
          '--single-transaction',
          '--exit-on-error',
          '-d',
          database,
        ],
        archive,
      )
      const history = JSON.parse(
        sql(
          database,
          `
        SELECT coalesce(json_agg(m ORDER BY position), '[]'::json)
        FROM public.open3dfarm_migrations m
      `,
        ),
      )
      if (Array.isArray(history) && history.length > catalog.length)
        throw new Error('Dump schema is newer than this release')
      if (validateMigrationHistory(catalog, history) < 13)
        throw new Error('Dump predates the browser trust schema')
      sql(
        database,
        `
        BEGIN;
        UPDATE farm.account_sessions SET revoked_at = greatest(created_at,
          floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint)
          WHERE revoked_at IS NULL;
        UPDATE farm.session_accounts SET session_version = session_version + 1;
        UPDATE farm.browser_device_keys SET status = 'revoked',
          revoked_at = greatest(created_at, floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint),
          revoked_by = account_id WHERE status <> 'revoked';
        COMMIT;
      `,
      )
      for (const directory of stateDirectories) fenceConnector(directory)
      copyConnectorConfig(backup, target, kind)
      sql('postgres', `ALTER DATABASE "${database}" CONNECTION LIMIT -1`)
    } catch (error) {
      try {
        sql('postgres', `DROP DATABASE "${database}"`)
      } catch {
        throw new Error(
          'Restore failed and the isolated database needs manual cleanup',
          { cause: error },
        )
      }
      throw error
    }
  } finally {
    closeSync(archive)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, ...args] = process.argv.slice(2)
  try {
    if (action === 'fence' && args.length === 1 && args[0]) {
      fenceConnector(args[0])
    } else {
      const [container, database, dump, kind, backup, target, ...directories] =
        args
      if (
        action !== 'restore' ||
        !container ||
        !database ||
        !dump ||
        (kind !== 'collector' && kind !== 'provisioning') ||
        !backup ||
        !target ||
        !directories.length
      )
        throw new Error(
          'Uso: restore CONTAINER BANCO_NOVO DUMP collector|provisioning BACKUP CONFIG_NOVA DIRETORIO_ESTADO... ou fence DIRETORIO_ESTADO',
        )
      await restore(
        container,
        database,
        dump,
        kind,
        backup,
        target,
        directories,
      )
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Restauração recusada',
    )
    process.exitCode = 1
  }
}
