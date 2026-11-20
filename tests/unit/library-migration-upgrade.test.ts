import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { Sql } from 'postgres'
import {
  catalogThrough,
  executableMigrationSql,
  loadMigrationCatalog,
  runMigrations,
  validateMigrationHistory,
} from '../../scripts/db/migrations.ts'
import {
  disposablePostgres,
  findPostgresBin,
} from '../helpers/disposable-postgres.ts'

const LIBRARY_ID = '0080_integration_library_api'
const PREVIOUS_ID = '0079_bambu_cloud_accounts'
// SHA-256 of JSON [id, shipped up, shipped down]. Do not retune this after
// editing 0080; restore the released file instead.
const SHIPPED_CHECKSUM =
  '1a25ad93f647fb32163daae2726c7716608cb01c65321b6756d4b0ef2d338d5e'

describe('shipped 0080 library migration', () => {
  test('keeps the released file and checksum, and matches both constraint renderings at execution', async () => {
    const catalog = await loadMigrationCatalog()
    const migration = catalog.find((entry) => entry.id === LIBRARY_ID)
    const previous = catalog.find((entry) => entry.id === PREVIOUS_ID)
    expect(migration).toBeDefined()
    expect(previous).toBeDefined()
    if (!migration || !previous) return
    expect(migration.checksum).toBe(SHIPPED_CHECKSUM)
    expect(
      createHash('sha256')
        .update(JSON.stringify([migration.id, migration.up, migration.down]))
        .digest('hex'),
    ).toBe(SHIPPED_CHECKSUM)
    expect(migration.up).toContain(
      "pg_get_constraintdef(c.oid) LIKE '%required_scope IN%'",
    )
    expect(migration.up).toContain(
      "pg_get_constraintdef(c.oid) LIKE '%action IN%'",
    )
    expect(migration.up).toContain(
      "pg_get_constraintdef(c.oid) LIKE '%resource_type IN%'",
    )
    expect(migration.up).not.toContain('= ANY')
    const executed = executableMigrationSql(migration, 'up')
    expect(executed).not.toBe(migration.up)
    for (const pattern of [
      '%required_scope IN%',
      '%action IN%',
      '%resource_type IN%',
    ]) {
      const anyPattern = pattern.replace(' IN%', ' = ANY%')
      expect(executed).toContain(
        `pg_get_constraintdef(c.oid) LIKE ANY (ARRAY['${pattern}','${anyPattern}'])`,
      )
      expect(executed).not.toContain(`LIKE '${pattern}'`)
    }
    expect(executed).toContain(
      'ADD CONSTRAINT integration_envelopes_required_scope_check',
    )
    expect(executed).toContain('ADD CONSTRAINT integration_audit_action_check')
    expect(executed).toContain(
      'ADD CONSTRAINT integration_audit_resource_type_check',
    )
    expect(executed).toContain(
      'ADD CONSTRAINT integration_webhooks_events_check',
    )
    expect(executableMigrationSql(migration, 'down')).toBe(migration.down)
    expect(executableMigrationSql(previous, 'up')).toBe(previous.up)
    expect(executableMigrationSql(previous, 'down')).toBe(previous.down)
    expect(() =>
      executableMigrationSql(
        { id: LIBRARY_ID, up: 'SELECT 1;', down: 'SELECT 1;' },
        'up',
      ),
    ).toThrow(/constraint lookup changed/)
  })
})

interface CheckRow {
  relname: string
  conname: string
  def: string
}

async function constraintDefs(sql: Sql): Promise<CheckRow[]> {
  return [
    ...(await sql<CheckRow[]>`
      SELECT t.relname, c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'farm'
        AND c.contype = 'c'
        AND c.conname IN (
          'integration_envelopes_required_scope_check',
          'integration_audit_action_check',
          'integration_audit_resource_type_check',
          'integration_webhooks_events_check'
        )
      ORDER BY 1, 2
    `),
  ]
}

function def(rows: readonly CheckRow[], name: string): string {
  const row = rows.find((entry) => entry.conname === name)
  expect(row, name).toBeDefined()
  return row?.def ?? ''
}

async function withCluster(
  name: string,
  through: string | false,
  body: (sql: Sql) => Promise<void>,
) {
  delete process.env.OPENFARM_PG
  const ledgerDir = mkdtempSync(join(tmpdir(), 'o3dfm-migration-ledger-'))
  const ledgerPath = join(ledgerDir, 'resources.log')
  const database = disposablePostgres({
    name,
    isolated: true,
    through,
    ledger: (value) => {
      appendFileSync(ledgerPath, `${name} ${JSON.stringify(value)}\n`, {
        mode: 0o600,
      })
    },
  })
  try {
    await body(await database.start())
  } finally {
    try {
      await database.stop()
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true })
    }
  }
}

const postgresReady = (() => {
  try {
    findPostgresBin()
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!postgresReady)('0080 upgrade on isolated PostgreSQL', () => {
  test('upgrades an existing database, rolls back, and upgrades again', async () => {
    await withCluster('o3dfm-387-existing', PREVIOUS_ID, async (sql) => {
      const catalog = await loadMigrationCatalog()
      const previous = catalogThrough(catalog, PREVIOUS_ID)
      const through = catalogThrough(catalog, LIBRARY_ID)
      const shipped = through.at(-1)
      expect(shipped?.id).toBe(LIBRARY_ID)
      if (!shipped) return
      expect(
        validateMigrationHistory(previous, [...(await journal(sql))]),
      ).toBe(previous.length)
      const before = await constraintDefs(sql)
      expect(
        def(before, 'integration_envelopes_required_scope_check'),
      ).toContain('required_scope = ANY')
      expect(
        def(before, 'integration_envelopes_required_scope_check'),
      ).not.toContain('jobs:write')
      expect(def(before, 'integration_audit_action_check')).toContain(
        'action = ANY',
      )
      expect(def(before, 'integration_audit_action_check')).not.toContain(
        'library.changed',
      )
      expect(def(before, 'integration_audit_resource_type_check')).toContain(
        'resource_type = ANY',
      )
      expect(def(before, 'integration_webhooks_events_check')).toContain(
        'cardinality(events) <= 6',
      )
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(shipped.up).simple()
        }),
      ).rejects.toThrow(/integration_envelopes_required_scope_check/)
      expect(await constraintDefs(sql)).toEqual(before)
      expect(await columnPresent(sql)).toBe(false)
      expect(
        validateMigrationHistory(previous, [...(await journal(sql))]),
      ).toBe(previous.length)

      expect(await runMigrations(sql, through, { kind: 'up' })).toEqual([
        LIBRARY_ID,
      ])
      await expectUpgraded(sql, through)

      expect(
        await runMigrations(sql, through, {
          kind: 'down',
          expectedLastId: LIBRARY_ID,
        }),
      ).toEqual([LIBRARY_ID])
      await expectRolledBack(sql, previous)

      expect(await runMigrations(sql, through, { kind: 'up' })).toEqual([
        LIBRARY_ID,
      ])
      await expectUpgraded(sql, through)
    })
  }, 180000)

  test('applies 0080 on a fresh database and rolls it back', async () => {
    await withCluster('o3dfm-387-fresh', false, async (sql) => {
      const through = catalogThrough(await loadMigrationCatalog(), LIBRARY_ID)
      expect(await runMigrations(sql, through, { kind: 'up' })).toEqual(
        through.map((entry) => entry.id),
      )
      await expectUpgraded(sql, through)
      expect(
        await runMigrations(sql, through, {
          kind: 'down',
          expectedLastId: LIBRARY_ID,
        }),
      ).toEqual([LIBRARY_ID])
      const previous = catalogThrough(await loadMigrationCatalog(), PREVIOUS_ID)
      await expectRolledBack(sql, previous)
      expect(await runMigrations(sql, through, { kind: 'up' })).toEqual([
        LIBRARY_ID,
      ])
      await expectUpgraded(sql, through)
    })
  }, 180000)
})

function journal(sql: Sql) {
  return sql`SELECT position, id, checksum FROM public.open3dfarm_migrations ORDER BY position`
}

async function columnPresent(sql: Sql) {
  const rows = await sql`
    SELECT 1 AS present
    FROM information_schema.columns
    WHERE table_schema = 'farm'
      AND table_name = 'integration_jobs'
      AND column_name = 'library_version_id'
  `
  return rows.length === 1
}

async function scopeFunction(sql: Sql) {
  const rows = await sql<{ def: string }[]>`
    SELECT pg_get_functiondef('farm.integration_scopes_valid(text[])'::regprocedure) AS def
  `
  return rows[0]?.def ?? ''
}

async function expectUpgraded(
  sql: Sql,
  through: ReturnType<typeof catalogThrough>,
) {
  expect(validateMigrationHistory(through, [...(await journal(sql))])).toBe(
    through.length,
  )
  const shipped = through.at(-1)
  expect(shipped?.checksum).toBe(SHIPPED_CHECKSUM)
  const rows = await journal(sql)
  expect(rows.at(-1)?.checksum).toBe(SHIPPED_CHECKSUM)
  const checks = await constraintDefs(sql)
  expect(def(checks, 'integration_envelopes_required_scope_check')).toContain(
    'jobs:write',
  )
  expect(def(checks, 'integration_audit_action_check')).toContain(
    'library.changed',
  )
  expect(def(checks, 'integration_audit_resource_type_check')).toContain(
    'library',
  )
  expect(def(checks, 'integration_webhooks_events_check')).toContain(
    'cardinality(events) <= 7',
  )
  expect(await columnPresent(sql)).toBe(true)
  const scopes = await scopeFunction(sql)
  expect(scopes).toContain('library:read')
  expect(scopes).toContain('library:write')
}

async function expectRolledBack(
  sql: Sql,
  previous: ReturnType<typeof catalogThrough>,
) {
  expect(validateMigrationHistory(previous, [...(await journal(sql))])).toBe(
    previous.length,
  )
  const checks = await constraintDefs(sql)
  const required = def(checks, 'integration_envelopes_required_scope_check')
  expect(required).not.toContain('jobs:write')
  expect(required).toContain('control:extended')
  expect(def(checks, 'integration_audit_action_check')).not.toContain(
    'library.changed',
  )
  expect(def(checks, 'integration_audit_resource_type_check')).not.toContain(
    'library',
  )
  expect(def(checks, 'integration_webhooks_events_check')).toContain(
    'cardinality(events) <= 6',
  )
  expect(await columnPresent(sql)).toBe(false)
  expect(await scopeFunction(sql)).not.toContain('library:read')
}
