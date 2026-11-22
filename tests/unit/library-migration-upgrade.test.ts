import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Sql } from 'postgres'
import {
  catalogThrough,
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
describe('0080 library migration', () => {
  test('drops the previous checks by name and preserves the webhook cardinality lookup', async () => {
    const catalog = await loadMigrationCatalog()
    const migration = catalog.find((entry) => entry.id === LIBRARY_ID)
    const previous = catalog.find((entry) => entry.id === PREVIOUS_ID)
    expect(migration).toBeDefined()
    expect(previous).toBeDefined()
    if (!migration || !previous) return
    for (const name of [
      'integration_envelopes_required_scope_check',
      'integration_audit_action_check',
      'integration_audit_resource_type_check',
    ]) {
      expect(migration.up).toContain(`DROP CONSTRAINT IF EXISTS ${name}`)
      expect(
        migration.up.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`),
      ).toBeLessThan(migration.up.indexOf(`ADD CONSTRAINT ${name}`))
      expect(
        migration.up.match(
          new RegExp(`DROP CONSTRAINT IF EXISTS ${name}`, 'g'),
        ),
      ).toHaveLength(1)
    }
    expect(migration.up).toContain(
      "CHECK (required_scope IN ('jobs:start', 'jobs:write', 'control:basic', 'control:extended'))",
    )
    expect(migration.up).toContain("'credential.event', 'library.changed'")
    expect(migration.up).toContain("'subscription', 'credential', 'library'")
    expect(migration.up).toContain(
      "pg_get_constraintdef(c.oid) LIKE '%cardinality(events)%'",
    )
    expect(migration.up).toContain(
      'CHECK (cardinality(events) BETWEEN 1 AND 7)',
    )
    expect(migration.up).not.toMatch(
      /pg_get_constraintdef\s*\([^)]*\)\s*LIKE\s+'%[^']*\s+IN%'/i,
    )
    expect(migration.up).not.toContain('LIKE ANY')
    expect(migration.down).toContain(
      'DROP CONSTRAINT integration_envelopes_required_scope_check',
    )
    expect(migration.down).toContain(
      'DROP CONSTRAINT integration_audit_action_check',
    )
    expect(migration.down).toContain(
      'DROP CONSTRAINT integration_audit_resource_type_check',
    )
    expect(
      createHash('sha256')
        .update(JSON.stringify([migration.id, migration.up, migration.down]))
        .digest('hex'),
    ).toBe(migration.checksum)
    expect(migration.up).toContain(
      'ADD CONSTRAINT integration_envelopes_required_scope_check',
    )
    expect(migration.up).toContain(
      'ADD CONSTRAINT integration_audit_action_check',
    )
    expect(migration.up).toContain(
      'ADD CONSTRAINT integration_audit_resource_type_check',
    )
    expect(migration.up).toContain(
      'ADD CONSTRAINT integration_webhooks_events_check',
    )
    expect(
      migration.up.match(/ADD CONSTRAINT integration_[a-z_]+_check/g),
    ).toEqual([
      'ADD CONSTRAINT integration_envelopes_required_scope_check',
      'ADD CONSTRAINT integration_audit_action_check',
      'ADD CONSTRAINT integration_audit_resource_type_check',
      'ADD CONSTRAINT integration_webhooks_events_check',
    ])
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

async function cleanupCluster(stop: () => Promise<void>, ledgerPath: string) {
  try {
    await stop()
  } catch (cause) {
    throw new Error(
      `Database cleanup failed. Resource ledger retained at ${ledgerPath}`,
      {
        cause,
      },
    )
  }
  rmSync(dirname(ledgerPath), { recursive: true, force: true })
}

test('retains and reports the resource ledger when database cleanup fails', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'o3dfm-migration-ledger-check-'))
  const ledgerPath = join(ledgerDir, 'resources.log')
  const record = '{"resource":"cluster","name":"fixture"}\n'
  const failure = new Error('simulated stop failure')

  try {
    writeFileSync(ledgerPath, record, { mode: 0o600 })
    await expect(
      cleanupCluster(async () => {
        throw failure
      }, ledgerPath),
    ).rejects.toMatchObject({
      message: `Database cleanup failed. Resource ledger retained at ${ledgerPath}`,
      cause: failure,
    })
    expect(readFileSync(ledgerPath, 'utf8')).toBe(record)
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true })
  }
})

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
    await cleanupCluster(() => database.stop(), ledgerPath)
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
          throw new Error('rollback successful 0080 execution probe')
        }),
      ).rejects.toThrow('rollback successful 0080 execution probe')
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
  expect(shipped).toBeDefined()
  const rows = await journal(sql)
  expect(rows.at(-1)?.checksum).toBe(shipped?.checksum)
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
