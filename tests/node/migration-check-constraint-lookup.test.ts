import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'
import { testPostgresMigrations } from '../helpers/postgres-migrations-integration.ts'

const migrationsDir = new URL('../../infra/db/migrations/', import.meta.url)

test('no migration locates check constraints with an IN-list LIKE lookup', async () => {
  const files = await readdir(migrationsDir)
  const migrations = files.filter((file) => file.endsWith('.sql'))
  const offenders: string[] = []

  for (const file of migrations) {
    const source = await readFile(new URL(file, migrationsDir), 'utf8')
    if (/pg_get_constraintdef\s*\([^)]*\)[\s\S]{0,200}?LIKE\s+'%[^']*\s+IN%'/i.test(source))
      offenders.push(file)
  }

  assert.deepEqual(offenders, [])
})

test('all migrations apply, roll back, and apply again on disposable PostgreSQL', async (context) => {
  try {
    findPostgresBin()
  } catch (error) {
    context.skip(`PostgreSQL binaries unavailable: ${String(error)}`)
    return
  }

  delete process.env.OPENFARM_PG
  const name = `o3dfm-627-migration-roundtrip-${process.pid}`
  const database = disposablePostgres({ name, isolated: true, through: false })
  try {
    const sql = await database.start()
    try {
      await testPostgresMigrations(sql)
    } finally {
      await sql.end({ timeout: 5 })
    }
  } finally {
    await database.stop()
  }
})
