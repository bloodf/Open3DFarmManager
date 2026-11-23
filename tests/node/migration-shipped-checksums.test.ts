import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  executableMigrationSql,
  loadMigrationCatalog,
} from '../../scripts/db/migrations.ts'

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

test('0090 retains its shipped catalog checksum and declares network_deleted only at rollback execution', async () => {
  const retention = (await loadMigrationCatalog()).find(
    ({ id }) => id === '0090_review_601_retention',
  )
  assert.ok(retention)
  assert.equal(
    retention.checksum,
    '0285bb12f92bcef3e28efa7250193fb5021531fcb08b6e0d2381319416c5c191',
  )
  const executableDown = executableMigrationSql(retention, 'down')
  const declaration = '  network_deleted integer;\n'
  assert.ok(executableDown.includes(`${declaration}BEGIN\n`))
  assert.equal(executableDown.replace(declaration, ''), retention.down)
  assert.equal(executableMigrationSql(retention, 'up'), retention.up)
  assert.throws(
    () =>
      executableMigrationSql(
        { ...retention, down: retention.down + '\n' },
        'down',
      ),
    /Shipped 0090_review_601_retention down SQL changed/,
  )
})
