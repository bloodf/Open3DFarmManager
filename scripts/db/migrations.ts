import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { Sql } from 'postgres'

export function migrationCatalog(
  sources: readonly { name: string; sql: string }[],
) {
  const pairs = new Map<string, { up?: string; down?: string }>()
  for (const source of sources) {
    const match = /^(\d{4}_[a-z][a-z0-9_]*)\.(up|down)\.sql$/.exec(source.name)
    const id = match?.[1]
    const direction = match?.[2]
    if (
      !id ||
      (direction !== 'up' && direction !== 'down') ||
      !source.sql.trim()
    )
      throw new Error('Invalid migration source')
    const pair = pairs.get(id) ?? {}
    if (pair[direction] !== undefined)
      throw new Error('Duplicate migration source')
    pair[direction] = source.sql
    pairs.set(id, pair)
  }
  return [...pairs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, pair], index) => {
      if (
        Number(id.slice(0, 4)) !== index + 1 ||
        pair.up === undefined ||
        pair.down === undefined
      )
        throw new Error(
          'Migrations must be contiguous paired files starting at 0001',
        )
      return Object.freeze({
        id,
        up: pair.up,
        down: pair.down,
        checksum: createHash('sha256')
          .update(JSON.stringify([id, pair.up, pair.down]))
          .digest('hex'),
      })
    })
}

export async function loadMigrationCatalog(
  directory = new URL('../../infra/db/migrations/', import.meta.url),
) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('Migration directory must contain regular SQL files only')
  return migrationCatalog(
    await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        sql: await readFile(new URL(entry.name, directory), 'utf8'),
      })),
    ),
  )
}

export function validateMigrationHistory(
  catalog: ReturnType<typeof migrationCatalog>,
  input: unknown,
) {
  if (!Array.isArray(input)) throw new Error('Invalid migration history')
  for (const [index, row] of input.entries()) {
    if (
      typeof row !== 'object' ||
      row === null ||
      Object.keys(row).sort().join(',') !== 'checksum,id,position'
    )
      throw new Error('Invalid migration history')
    const migration = catalog[index]
    if (
      row.position !== index + 1 ||
      !migration ||
      row.id !== migration.id ||
      row.checksum !== migration.checksum
    )
      throw new Error('Migration history does not match the local catalog')
  }
  return input.length
}

export type MigrationAction =
  { kind: 'up' } | { kind: 'down'; expectedLastId: string }

/** Trusted, reviewed local SQL only; not a SQL sandbox or production startup hook. */
export async function runMigrations(
  sql: Sql,
  catalog: ReturnType<typeof migrationCatalog>,
  action: MigrationAction,
) {
  // Snapshot and recompute digests before waiting for a database lock.
  const checked = migrationCatalog(
    catalog.flatMap((entry) => [
      { name: `${entry.id}.up.sql`, sql: entry.up },
      { name: `${entry.id}.down.sql`, sql: entry.down },
    ]),
  )
  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5000ms'`
    await tx`SET LOCAL statement_timeout = '30000ms'`
    await tx`SELECT pg_advisory_xact_lock(1870033, 1)`
    await tx`CREATE TABLE IF NOT EXISTS public.open3dfarm_migrations (
      position integer PRIMARY KEY CHECK (position > 0),
      id text UNIQUE NOT NULL,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$')
    )`
    const history =
      await tx`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
    const applied = validateMigrationHistory(checked, [...history])
    const changed: string[] = []
    if (action.kind === 'down') {
      const last = checked[applied - 1]
      if (!last || last.id !== action.expectedLastId)
        throw new Error('Rollback requires the exact last applied migration ID')
      await tx.unsafe(last.down).simple()
      await tx`DELETE FROM public.open3dfarm_migrations WHERE position = ${applied}`
      changed.push(last.id)
    } else {
      for (let index = applied; index < checked.length; index++) {
        const migration = checked[index]
        if (!migration) throw new Error('Missing migration')
        await tx.unsafe(migration.up).simple()
        await tx`INSERT INTO public.open3dfarm_migrations (position, id, checksum) VALUES (${index + 1}, ${migration.id}, ${migration.checksum})`
        changed.push(migration.id)
      }
    }
    return changed
  })
}
