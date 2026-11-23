import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import {
  loadMigrationCatalog,
  migrationCatalog,
  runMigrations,
} from '../../scripts/db/migrations.ts'

/** Destructive fixture: caller provides a fresh isolated disposable fixture database. */
export async function testPostgresMigrations(sql: Sql, through?: string) {
  const baseline =
    await sql`SELECT current_database() AS db, current_user AS actor, to_regclass('public.open3dfarm_migrations') AS journal, EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'farm') AS farm`
  assert.equal(baseline[0]?.db, 'fixture')
  assert.equal(baseline[0]?.actor, 'fixture')
  assert.equal(baseline[0]?.journal, null)
  assert.equal(baseline[0]?.farm, false)
  const fullCatalog = await loadMigrationCatalog()
  const index = through
    ? fullCatalog.findIndex((entry) => entry.id === through)
    : -1
  if (through) assert.ok(index >= 0, 'Unknown migration prefix')
  const catalog = through ? fullCatalog.slice(0, index + 1) : fullCatalog
  const firstMigration = catalog[0]
  assert.ok(firstMigration)
  const sources = catalog.flatMap((entry) => [
    { name: `${entry.id}.up.sql`, sql: entry.up },
    { name: `${entry.id}.down.sql`, sql: entry.down },
  ])
  const checks: string[] = []
  const results = await Promise.all([
    runMigrations(sql, catalog, { kind: 'up' }),
    runMigrations(sql, catalog, { kind: 'up' }),
  ])
  assert.deepEqual(
    results.map((result) => result.length).sort((a, b) => a - b),
    [0, catalog.length],
  )
  assert.deepEqual(await runMigrations(sql, catalog, { kind: 'up' }), [])
  checks.push('concurrent-migrators-and-idempotent-apply')
  const snapshot = async () => [
    ...(await sql`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`),
  ]
  const before = await snapshot()
  const tampered = migrationCatalog(
    sources.map((source, index) => ({
      ...source,
      sql: source.sql + (index === 1 ? '\n-- changed rollback' : ''),
    })),
  )
  await assert.rejects(runMigrations(sql, tampered, { kind: 'up' }))
  assert.deepEqual(await snapshot(), before)
  checks.push('edited-applied-rollback-digest-rejected')
  await sql`UPDATE public.open3dfarm_migrations SET id = '0001_unknown' WHERE position = 1`
  await assert.rejects(runMigrations(sql, catalog, { kind: 'up' }))
  await sql`UPDATE public.open3dfarm_migrations SET id = ${firstMigration.id} WHERE position = 1`
  await sql`UPDATE public.open3dfarm_migrations SET position = 999 WHERE position = 1`
  await assert.rejects(runMigrations(sql, catalog, { kind: 'up' }))
  await sql`UPDATE public.open3dfarm_migrations SET position = 1 WHERE position = 999`
  assert.deepEqual(await snapshot(), before)
  checks.push('unknown-and-out-of-order-history-rejected')
  const failingId = `${String(catalog.length + 1).padStart(4, '0')}_failure_fixture`
  const failing = migrationCatalog([
    ...sources,
    {
      name: `${failingId}.up.sql`,
      sql: 'CREATE TABLE public.migration_failure_probe(id integer); SELECT 1/0;',
    },
    {
      name: `${failingId}.down.sql`,
      sql: 'DROP TABLE public.migration_failure_probe;',
    },
  ])
  await assert.rejects(runMigrations(sql, failing, { kind: 'up' }))
  assert.equal(
    (
      await sql`SELECT to_regclass('public.migration_failure_probe') AS relation`
    )[0]?.relation,
    null,
  )
  assert.deepEqual(await snapshot(), before)
  checks.push('failed-ddl-and-journal-transaction-rolled-back')
  await assert.rejects(
    runMigrations(sql, catalog, { kind: 'down', expectedLastId: 'wrong' }),
  )
  // Physical rollback walks the whole catalog down unless a migration retains
  // committed history and refuses by design; the durable floor stays applied
  // and everything above it still rolls down and back up.
  const durableIndex = catalog.findIndex(
    (entry) => entry.id === '0026_configuration',
  )
  if (durableIndex >= 0) {
    const rollbackIds = [...catalog]
      .slice(durableIndex + 1)
      .reverse()
      .map((entry) => entry.id)
    assert.ok(rollbackIds.length > 0)
    for (const id of rollbackIds)
      await runMigrations(sql, catalog, { kind: 'down', expectedLastId: id })
    const durable = catalog[durableIndex]
    assert.ok(durable)
    await assert.rejects(
      runMigrations(sql, catalog, {
        kind: 'down',
        expectedLastId: durable.id,
      }),
      /rollback refused/,
    )
    assert.deepEqual(await snapshot(), before.slice(0, durableIndex + 1))
    checks.push('durable-configuration-history-rollback-refused')
    assert.equal(
      (await runMigrations(sql, catalog, { kind: 'up' })).length,
      rollbackIds.length,
    )
    checks.push('migrations-above-durable-floor-down-and-up')
    for (const id of rollbackIds)
      await runMigrations(sql, catalog, { kind: 'down', expectedLastId: id })
    await assert.rejects(
      runMigrations(sql, catalog, {
        kind: 'down',
        expectedLastId: durable.id,
      }),
      /rollback refused/,
    )
    assert.equal((await snapshot()).length, durableIndex + 1)
    checks.push('durable-floor-remains-for-cluster-cleanup')
    return checks
  }
  for (const entry of [...catalog].reverse())
    await runMigrations(sql, catalog, {
      kind: 'down',
      expectedLastId: entry.id,
    })
  assert.deepEqual(await snapshot(), [])
  assert.equal(
    (
      await sql`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'farm') AS present`
    )[0]?.present,
    false,
  )
  assert.equal(
    (await runMigrations(sql, catalog, { kind: 'up' })).length,
    catalog.length,
  )
  checks.push('explicit-last-only-down-through-schema-drop-and-up')
  for (const entry of [...catalog].reverse())
    await runMigrations(sql, catalog, {
      kind: 'down',
      expectedLastId: entry.id,
    })
  await sql`DROP TABLE public.open3dfarm_migrations`
  checks.push('fixture-schema-roles-and-journal-cleaned')
  return checks
}
