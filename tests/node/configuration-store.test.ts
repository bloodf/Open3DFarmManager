import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadMigrationCatalog } from '../../scripts/db/migrations.ts'

test('production migration is catalogued and rollback preserves receipt history', async () => {
  const catalog = await loadMigrationCatalog()
  const migration = catalog.at(-1)
  assert.equal(migration?.id, '0026_configuration')
  assert.match(migration!.up, /REFERENCES farm.printer_assignments/)
  assert.match(migration!.down, /RAISE EXCEPTION/)
  assert.doesNotMatch(migration!.down, /DROP TABLE/)
})
test('production plugin installs the runtime after schema and persistent key checks', async () => {
  const source = await readFile(
    'apps/farm/server/plugins/configuration-lifecycle.ts',
    'utf8',
  )
  assert.match(source, /installConfigurationRuntime\(/)
  assert.ok(
    source.indexOf('await schemaState') <
      source.indexOf('uninstall = installConfigurationRuntime'),
  )
  assert.ok(
    source.indexOf('await loadConfigurationIssuerKey') <
      source.indexOf('uninstall = installConfigurationRuntime'),
  )
  assert.match(source, /hooks.hook\('close'/)
  assert.doesNotMatch(source, /generateKey/)
})
test('production store binds every configuration record through the driver jsonb parameter', async () => {
  const source = await readFile(
    'apps/farm/server/storage/postgres-configuration.ts',
    'utf8',
  )
  assert.doesNotMatch(source, /JSON\.stringify/)
  assert.match(source, /return tx\.json\(record\)/)
  for (const table of [
    'configuration_operations',
    'configuration_challenges',
    'configuration_receipts',
  ]) {
    assert.match(
      source,
      new RegExp(
        `INSERT INTO farm\\.${table}\\([^)]*\\brecord\\)[^\`]*\\$\\{jsonbRecord\\(tx, r\\)\\}`,
      ),
    )
  }
})
