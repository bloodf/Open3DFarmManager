import { describe, expect, test } from 'vitest'
import {
  EXPAND_CONTRACT_ALLOWLIST,
  findDestructiveOperations,
  stripSqlCommentsAndStrings,
  validateMigrationHistoryChecksum,
  validateMigrationSafety,
  type MigrationSource,
} from '../../scripts/db/migration-rules.ts'
import {
  loadMigrationCatalog,
  migrationCatalog,
  validateMigrationHistory,
} from '../../scripts/db/migrations.ts'

describe('migration upgrade safety rules', () => {
  test('current repository catalog passes all safety rules', async () => {
    const catalog = await loadMigrationCatalog()
    expect(catalog.length).toBeGreaterThanOrEqual(28)
    const sources: MigrationSource[] = catalog.flatMap((entry) => [
      { name: `${entry.id}.up.sql`, sql: entry.up },
      { name: `${entry.id}.down.sql`, sql: entry.down },
    ])
    expect(() => validateMigrationSafety(sources)).not.toThrow()
  })

  test('exported allowlist is empty by default', () => {
    expect(EXPAND_CONTRACT_ALLOWLIST).toEqual([])
  })

  test('stripSqlCommentsAndStrings ignores line comments, block comments, and string literals', () => {
    const rawSql = `
      -- DROP TABLE ignored_table;
      /*
         DROP COLUMN ignored_col;
         TRUNCATE ignored_trunc;
      */
      SELECT 'DROP TABLE str_table' AS query;
      SELECT E'ALTER COLUMN str_col TYPE int' AS e_query;
      SELECT $$TRUNCATE dollar_table$$ AS dollar_query;
      SELECT $tag$DELETE FROM tag_table$tag$ AS tag_query;
      SELECT 1;
    `
    const stripped = stripSqlCommentsAndStrings(rawSql)
    expect(findDestructiveOperations(stripped)).toEqual([])
  })

  test('rejects missing matching down or up files', () => {
    const missingDown: MigrationSource[] = [
      { name: '0001_initial.up.sql', sql: 'CREATE TABLE t (id int);' },
    ]
    expect(() => validateMigrationSafety(missingDown)).toThrow(
      /Missing matching down migration for 0001_initial/,
    )

    const missingUp: MigrationSource[] = [
      { name: '0001_initial.down.sql', sql: 'DROP TABLE t;' },
    ]
    expect(() => validateMigrationSafety(missingUp)).toThrow(
      /Missing matching up migration for 0001_initial/,
    )
  })

  test('rejects non-contiguous numbering or numbering not starting at 0001', () => {
    const notStartingAtOne: MigrationSource[] = [
      { name: '0002_initial.up.sql', sql: 'CREATE TABLE t (id int);' },
      { name: '0002_initial.down.sql', sql: 'DROP TABLE t;' },
    ]
    expect(() => validateMigrationSafety(notStartingAtOne)).toThrow(
      /Migration numbering must be contiguous starting from 0001/,
    )

    const gapInNumbering: MigrationSource[] = [
      { name: '0001_one.up.sql', sql: 'CREATE TABLE one (id int);' },
      { name: '0001_one.down.sql', sql: 'DROP TABLE one;' },
      { name: '0003_three.up.sql', sql: 'CREATE TABLE three (id int);' },
      { name: '0003_three.down.sql', sql: 'DROP TABLE three;' },
    ]
    expect(() => validateMigrationSafety(gapInNumbering)).toThrow(
      /Migration numbering must be contiguous starting from 0001/,
    )
  })

  test('allows historical migrations <= 0027 to use destructive patterns', () => {
    const historicalSources: MigrationSource[] = [
      {
        name: '0001_setup.up.sql',
        sql: 'CREATE TABLE t (id int); DROP TABLE old_t; TRUNCATE prev_t;',
      },
      { name: '0001_setup.down.sql', sql: 'DROP TABLE t;' },
    ]
    expect(() => validateMigrationSafety(historicalSources)).not.toThrow()
  })

  test('rejects DROP TABLE in migrations above 0027', () => {
    const sources: MigrationSource[] = [
      ...Array.from({ length: 27 }, (_, i) => {
        const id = String(i + 1).padStart(4, '0') + '_step'
        return [
          { name: `${id}.up.sql`, sql: 'SELECT 1;' },
          { name: `${id}.down.sql`, sql: 'SELECT 1;' },
        ]
      }).flat(),
      {
        name: '0028_bad.up.sql',
        sql: 'DROP TABLE users;',
      },
      { name: '0028_bad.down.sql', sql: 'SELECT 1;' },
    ]
    expect(() => validateMigrationSafety(sources)).toThrow(
      /violates expand\/contract upgrade safety: destructive operation 'DROP TABLE'/,
    )
  })

  test('rejects DROP COLUMN in migrations above 0027', () => {
    const makeSources = (destructiveSql: string): MigrationSource[] => [
      ...Array.from({ length: 27 }, (_, i) => {
        const id = String(i + 1).padStart(4, '0') + '_step'
        return [
          { name: `${id}.up.sql`, sql: 'SELECT 1;' },
          { name: `${id}.down.sql`, sql: 'SELECT 1;' },
        ]
      }).flat(),
      {
        name: '0028_bad.up.sql',
        sql: destructiveSql,
      },
      { name: '0028_bad.down.sql', sql: 'SELECT 1;' },
    ]

    expect(() =>
      validateMigrationSafety(
        makeSources('ALTER TABLE users DROP COLUMN email;'),
      ),
    ).toThrow(/destructive operation 'DROP COLUMN'/)

    expect(() =>
      validateMigrationSafety(makeSources('ALTER TABLE users DROP email;')),
    ).toThrow(/destructive operation 'DROP COLUMN'/)
  })

  test('rejects TRUNCATE in migrations above 0027 while ignoring trigger definitions', () => {
    const makeSources = (sql: string): MigrationSource[] => [
      ...Array.from({ length: 27 }, (_, i) => {
        const id = String(i + 1).padStart(4, '0') + '_step'
        return [
          { name: `${id}.up.sql`, sql: 'SELECT 1;' },
          { name: `${id}.down.sql`, sql: 'SELECT 1;' },
        ]
      }).flat(),
      {
        name: '0028_check.up.sql',
        sql,
      },
      { name: '0028_check.down.sql', sql: 'SELECT 1;' },
    ]

    // Trigger statements should be accepted
    expect(() =>
      validateMigrationSafety(
        makeSources(
          'CREATE TRIGGER t_no_trunc BEFORE TRUNCATE ON users FOR EACH STATEMENT EXECUTE FUNCTION f();',
        ),
      ),
    ).not.toThrow()

    // TRUNCATE statement should be rejected
    expect(() =>
      validateMigrationSafety(makeSources('TRUNCATE users;')),
    ).toThrow(/destructive operation 'TRUNCATE'/)
    expect(() =>
      validateMigrationSafety(makeSources('TRUNCATE TABLE users;')),
    ).toThrow(/destructive operation 'TRUNCATE'/)
  })

  test('rejects ALTER COLUMN ... TYPE in migrations above 0027', () => {
    const makeSources = (sql: string): MigrationSource[] => [
      ...Array.from({ length: 27 }, (_, i) => {
        const id = String(i + 1).padStart(4, '0') + '_step'
        return [
          { name: `${id}.up.sql`, sql: 'SELECT 1;' },
          { name: `${id}.down.sql`, sql: 'SELECT 1;' },
        ]
      }).flat(),
      {
        name: '0028_bad.up.sql',
        sql,
      },
      { name: '0028_bad.down.sql', sql: 'SELECT 1;' },
    ]

    expect(() =>
      validateMigrationSafety(
        makeSources('ALTER TABLE users ALTER COLUMN age TYPE bigint;'),
      ),
    ).toThrow(/destructive operation 'ALTER COLUMN ... TYPE'/)

    expect(() =>
      validateMigrationSafety(
        makeSources('ALTER TABLE users ALTER age SET DATA TYPE text;'),
      ),
    ).toThrow(/destructive operation 'ALTER COLUMN ... TYPE'/)
  })

  test('rejects DELETE without WHERE in migrations above 0027', () => {
    const makeSources = (sql: string): MigrationSource[] => [
      ...Array.from({ length: 27 }, (_, i) => {
        const id = String(i + 1).padStart(4, '0') + '_step'
        return [
          { name: `${id}.up.sql`, sql: 'SELECT 1;' },
          { name: `${id}.down.sql`, sql: 'SELECT 1;' },
        ]
      }).flat(),
      {
        name: '0028_bad.up.sql',
        sql,
      },
      { name: '0028_bad.down.sql', sql: 'SELECT 1;' },
    ]

    // DELETE with WHERE is allowed
    expect(() =>
      validateMigrationSafety(
        makeSources('DELETE FROM users WHERE active = false;'),
      ),
    ).not.toThrow()

    // DELETE without WHERE is rejected
    expect(() =>
      validateMigrationSafety(makeSources('DELETE FROM users;')),
    ).toThrow(/destructive operation 'DELETE without WHERE'/)

    // Multiple statements with one unconstrained DELETE
    expect(() =>
      validateMigrationSafety(
        makeSources('DELETE FROM users WHERE id = 1; DELETE FROM audit_log;'),
      ),
    ).toThrow(/destructive operation 'DELETE without WHERE'/)
  })

  test('honors allowlist with reason for approved exceptions', () => {
    const sources: MigrationSource[] = [
      ...Array.from({ length: 27 }, (_, i) => {
        const id = String(i + 1).padStart(4, '0') + '_step'
        return [
          { name: `${id}.up.sql`, sql: 'SELECT 1;' },
          { name: `${id}.down.sql`, sql: 'SELECT 1;' },
        ]
      }).flat(),
      {
        name: '0028_allowed.up.sql',
        sql: 'DROP TABLE legacy_temp_table;',
      },
      { name: '0028_allowed.down.sql', sql: 'SELECT 1;' },
    ]

    const allowlist = [
      {
        id: '0028_allowed',
        rule: 'DROP TABLE',
        reason: 'Temporary unreferenced table created in migration 0027',
      },
    ]

    expect(() => validateMigrationSafety(sources, allowlist)).not.toThrow()
  })

  test('checksum mismatch names the file and advises restoring the released file', () => {
    const pair = [
      {
        name: '0001_example.up.sql',
        sql: 'CREATE TABLE example(id integer);',
      },
      { name: '0001_example.down.sql', sql: 'DROP TABLE example;' },
    ]
    const catalog = migrationCatalog(pair)
    const first = catalog[0]
    if (!first) throw new Error('Missing catalog entry')

    const badRow = {
      position: 1,
      id: first.id,
      checksum: 'e'.repeat(64),
    }

    expect(() => validateMigrationHistory(catalog, [badRow])).toThrowError(
      /Migration history checksum mismatch for '0001_example': recorded checksum e{64} does not match local catalog checksum [a-f0-9]{64}. Restore the released migration file instead of editing already-applied migrations./,
    )
  })
})
