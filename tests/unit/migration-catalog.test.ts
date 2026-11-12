import { describe, expect, test } from 'vitest'
import {
  catalogThrough,
  loadMigrationCatalog,
  migrationCatalog,
  validateMigrationHistory,
} from '../../scripts/db/migrations.ts'

const pair = [
  { name: '0001_example.up.sql', sql: 'CREATE TABLE example(id integer);' },
  { name: '0001_example.down.sql', sql: 'DROP TABLE example;' },
]
describe('migration catalog', () => {
  test('loads repository pairs and hashes both directions deterministically', async () => {
    const repository = await loadMigrationCatalog()
    expect(repository.length).toBeGreaterThanOrEqual(23)
    expect(repository.map((entry) => entry.id.slice(0, 4))).toEqual(
      repository.map((_, index) => String(index + 1).padStart(4, '0')),
    )
    expect(repository[22]?.id).toBe('0023_connector_credential_renewals')
    expect(migrationCatalog(pair)).toEqual(
      migrationCatalog([...pair].reverse()),
    )
    const original = migrationCatalog(pair)[0]
    expect(
      migrationCatalog(
        pair.map((entry) => ({ ...entry, sql: entry.sql + '\n' })),
      )[0]?.checksum,
    ).not.toBe(original?.checksum)
  })
  test('rejects missing pairs, gaps, duplicate numbers, names and empty SQL', () => {
    for (const sources of [
      pair.slice(0, 1),
      [...pair, ...pair],
      pair.map((entry) => ({
        ...entry,
        name: entry.name.replace('0001', '0002'),
      })),
      pair.map((entry) => ({
        ...entry,
        name: entry.name.replace('example', '../example'),
      })),
      pair.map((entry) => ({ ...entry, sql: '' })),
      [
        ...pair,
        ...pair.map((entry) => ({
          ...entry,
          name: entry.name.replace('example', 'other'),
        })),
      ],
    ])
      expect(() => migrationCatalog(sources)).toThrow()
  })
  test('history must be the exact catalog prefix, including rollback checksums', () => {
    const catalog = migrationCatalog(pair)
    const first = catalog[0]
    if (!first) throw new Error('Fixture missing')
    const row = { position: 1, id: first.id, checksum: first.checksum }
    expect(validateMigrationHistory(catalog, [])).toBe(0)
    expect(validateMigrationHistory(catalog, [row])).toBe(1)
    for (const rows of [
      [{ ...row, position: 2 }],
      [{ ...row, id: '0001_unknown' }],
      [{ ...row, checksum: '0'.repeat(64) }],
      [row, { ...row, position: 2 }],
      [{ ...row, unexpected: true }],
    ])
      expect(() => validateMigrationHistory(catalog, rows)).toThrow()
  })

  test('catalogThrough returns the prefix ending at the id and rejects unknown ids', () => {
    const catalog = migrationCatalog([
      ...pair,
      { name: '0002_next.up.sql', sql: 'SELECT 1;' },
      { name: '0002_next.down.sql', sql: 'SELECT 2;' },
    ])
    const first = catalogThrough(catalog, '0001_example')
    expect(first).toEqual(catalog.slice(0, 1))
    expect(first.at(-1)?.id).toBe('0001_example')
    expect(catalogThrough(catalog, '0002_next')).toEqual(catalog)
    expect(() => catalogThrough(catalog, '0003_missing')).toThrow(
      /not in the catalog/,
    )
  })
})
