import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { loadMigrationCatalog } from '../../scripts/db/migrations.ts'

const read = (name: string) =>
  readFile(
    new URL(`../../infra/db/migrations/${name}`, import.meta.url),
    'utf8',
  )

describe('migration 0092 resin ledger', () => {
  test('is the next contiguous pair with a reversible down', async () => {
    const catalog = await loadMigrationCatalog()
    const entry = catalog.find((e) => e.id === '0092_resin_ledger')
    expect(entry).toBeDefined()
    expect(catalog[91]?.id).toBe('0092_resin_ledger')
    const down = await read('0092_resin_ledger.down.sql')
    expect(down).toMatch(/DROP TABLE farm\.resin_ledger_entries/)
    expect(down).toMatch(/DROP ROLE farm_resin_ledger/)
  })
  test('is farm scoped, append-only for the runtime role, and keeps unknown nullable', async () => {
    const up = await read('0092_resin_ledger.up.sql')
    expect(up).toMatch(/farm_id uuid NOT NULL REFERENCES farm\.farms\(id\)/)
    expect(up).toMatch(
      /FOREIGN KEY \(farm_id, printer_id\) REFERENCES farm\.printer_assignments \(farm_id, id\)/,
    )
    expect(up).toMatch(
      /source text NOT NULL CHECK \(source IN \('manual', 'reported'\)\)/,
    )
    expect(up).toMatch(
      /GRANT SELECT, INSERT ON farm\.resin_ledger_entries TO farm_resin_ledger/,
    )
    expect(up).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*resin_ledger_entries/)
    expect(up).toMatch(/volume_ml double precision\s+CHECK \(volume_ml IS NULL/)
    expect(up).not.toMatch(/volume_ml[^,]*DEFAULT/i)
  })
})
