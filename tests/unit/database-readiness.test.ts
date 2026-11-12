import { describe, expect, test } from 'vitest'
import type { Sql } from 'postgres'
import { migrationCatalog } from '../../scripts/db/migrations.ts'
import {
  databaseReadiness,
  prepareSchema,
  schemaState,
} from '../../apps/farm/server/utils/database/schema.ts'
import { parseDatabaseRuntimeConfig } from '../../apps/farm/server/utils/database/runtime.ts'

const catalog = migrationCatalog([
  { name: '0001_a.up.sql', sql: 'SELECT 1' },
  { name: '0001_a.down.sql', sql: 'SELECT 1' },
  { name: '0002_b.up.sql', sql: 'SELECT 1' },
  { name: '0002_b.down.sql', sql: 'SELECT 1' },
])
const journal = (ids: number) =>
  catalog
    .slice(0, ids)
    .map((m, i) => ({ position: i + 1, id: m.id, checksum: m.checksum }))

// Minimal tagged-template stub: first query is to_regclass, second the journal.
function fakeSql(rows: unknown[] | 'no-table' | Error): Sql {
  return ((strings: TemplateStringsArray) => {
    if (rows instanceof Error) return Promise.reject(rows)
    if (strings.join('').includes('to_regclass'))
      return Promise.resolve([{ name: rows === 'no-table' ? null : 'x' }])
    return Promise.resolve(rows === 'no-table' ? [] : rows)
  }) as unknown as Sql
}

describe('schemaState', () => {
  test.each([
    ['no-table', 'pending'],
    [journal(0), 'pending'],
    [journal(1), 'pending'],
    [journal(2), 'current'],
    [[{ ...journal(2)[0], checksum: 'f'.repeat(64) }], 'mismatch'],
    [
      [...journal(2), { position: 3, id: 'x', checksum: 'f'.repeat(64) }],
      'mismatch',
    ],
  ] as const)('%j -> %s', async (rows, expected) => {
    expect(await schemaState(fakeSql(rows as never), catalog)).toBe(expected)
  })
})

describe('prepareSchema (startup gate)', () => {
  test('resolves only when current', async () => {
    await expect(
      prepareSchema(fakeSql(journal(2)), catalog, 'verify'),
    ).resolves.toBeUndefined()
  })
  test.each([journal(1), 'no-table'] as const)(
    'verify rejects pending',
    async (rows) => {
      await expect(
        prepareSchema(fakeSql(rows as never), catalog, 'verify'),
      ).rejects.toThrow('Database schema is pending')
    },
  )
  test('rejects on mismatch', async () => {
    await expect(
      prepareSchema(
        fakeSql([{ ...journal(1)[0], id: 'zzz' }]),
        catalog,
        'verify',
      ),
    ).rejects.toThrow('Database schema is mismatch')
  })
})

describe('databaseReadiness', () => {
  test('ok / pending / mismatch', async () => {
    expect(await databaseReadiness(fakeSql(journal(2)), catalog)).toBe('ok')
    expect(await databaseReadiness(fakeSql(journal(1)), catalog)).toBe(
      'schema-pending',
    )
    expect(
      await databaseReadiness(
        fakeSql([{ position: 1, id: 'q', checksum: 'x' }]),
        catalog,
      ),
    ).toBe('schema-mismatch')
  })
  test('driver errors collapse to unavailable without leaking details', async () => {
    const result = await databaseReadiness(
      fakeSql(
        new Error('password authentication failed for postgres://u:secret@h'),
      ),
      catalog,
    )
    expect(result).toBe('unavailable')
  })
  test('is bounded by the timeout', async () => {
    const hang = (() => new Promise(() => {})) as unknown as Sql
    const started = Date.now()
    expect(await databaseReadiness(hang, catalog, 50)).toBe('unavailable')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('parseDatabaseRuntimeConfig', () => {
  const good = {
    enabled: true,
    databaseUrl: 'postgres://u:p@127.0.0.1:5433/db',
    migrations: 'verify',
    migrationsDir: '/app/migrations',
  }
  test('disabled/absent is a no-op', () => {
    expect(parseDatabaseRuntimeConfig(undefined)).toBeUndefined()
    expect(
      parseDatabaseRuntimeConfig({ ...good, enabled: false }),
    ).toBeUndefined()
  })
  test('valid config parses; invalid enabled config throws', () => {
    expect(parseDatabaseRuntimeConfig(good)).toEqual(good)
    expect(() =>
      parseDatabaseRuntimeConfig({ ...good, databaseUrl: '' }),
    ).toThrow()
    expect(() =>
      parseDatabaseRuntimeConfig({ ...good, migrations: 'x' }),
    ).toThrow()
    expect(() =>
      parseDatabaseRuntimeConfig({ ...good, migrationsDir: '' }),
    ).toThrow()
  })
})
