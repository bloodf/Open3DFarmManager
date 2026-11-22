import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import {
  loadMigrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'
import { testPostgresMigrations } from '../helpers/postgres-migrations-integration.ts'

const migrationsDir = new URL('../../infra/db/migrations/', import.meta.url)

test('no migration locates check constraints with an IN-list LIKE lookup', async () => {
  const files = await readdir(migrationsDir)
  const migrations = files.filter((file) => file.endsWith('.sql'))
  const offenders: string[] = []

  for (const file of migrations) {
    const source = await readFile(new URL(file, migrationsDir), 'utf8')
    if (
      /pg_get_constraintdef\s*\([^)]*\)[\s\S]{0,200}?LIKE\s+'%[^']*\s+IN%'/i.test(
        source,
      )
    )
      offenders.push(file)
  }

  assert.deepEqual(offenders, [])
})

let postgresUnavailable: string | undefined
try {
  findPostgresBin()
} catch (error) {
  postgresUnavailable = `PostgreSQL binaries unavailable: ${String(error)}`
}

if (postgresUnavailable) {
  console.log(`SKIP PostgreSQL migration round-trip: ${postgresUnavailable}`)
} else {
  test('all migrations apply, while the prefix through 0080 rolls back and reapplies on disposable PostgreSQL', async () => {
    delete process.env.OPENFARM_PG
    const name = `o3dfm-627-migration-roundtrip-${process.pid}`
    const database = disposablePostgres({
      name,
      isolated: true,
      through: false,
    })
    try {
      const sql = await database.start()
      try {
        await testPostgresMigrations(sql, '0080_integration_library_api')
        const catalog = await loadMigrationCatalog()
        const durableIndex = catalog.findIndex(
          (migration) => migration.id === '0026_configuration',
        )
        assert.ok(durableIndex >= 0)
        assert.deepEqual(
          await runMigrations(sql, catalog, { kind: 'up' }),
          catalog.slice(durableIndex + 1).map((migration) => migration.id),
        )
      } finally {
        await sql.end({ timeout: 5 })
      }
    } finally {
      await database.stop()
    }
  })
}
