import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { executableMigrationSql } from '../../scripts/db/migrations.ts'

const id = '0080_integration_library_api'
const shippedSql = readFileSync(
  new URL(`../../infra/db/migrations/${id}.up.sql`, import.meta.url),
)
const migration = {
  id,
  up: shippedSql.toString('utf8'),
  down: readFileSync(
    new URL(`../../infra/db/migrations/${id}.down.sql`, import.meta.url),
    'utf8',
  ),
}

test('0080 retains its shipped SHA-256 checksum', () => {
  // Shipped migrations must never change. Fix them through the migrator shim or a forward migration.
  assert.equal(
    createHash('sha256').update(shippedSql).digest('hex'),
    '6bbb965f35bee18087d5d14b717240ce98976c5a6f3c5e7bc1b80fc776ad8e10',
  )
})

test('0080 up matches both IN and = ANY constraint definitions', () => {
  let expected = migration.up
  for (const column of ['required_scope', 'action', 'resource_type']) {
    const shippedLookup = `pg_get_constraintdef(c.oid) LIKE '%${column} IN%'`
    assert.ok(migration.up.includes(shippedLookup), shippedLookup)
    expected = expected.replaceAll(
      shippedLookup,
      `pg_get_constraintdef(c.oid) LIKE ANY (ARRAY['%${column} IN%','%${column} = ANY%'])`,
    )
  }
  assert.equal(executableMigrationSql(migration, 'up'), expected)
  assert.equal(executableMigrationSql(migration, 'down'), migration.down)
})

test('the constraint lookup shim leaves other migrations untouched', () => {
  const otherMigration = { ...migration, id: '0081_other_migration' }
  assert.equal(executableMigrationSql(otherMigration, 'up'), otherMigration.up)
  assert.equal(
    executableMigrationSql(otherMigration, 'down'),
    otherMigration.down,
  )
})
