import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('integration resin SQL privileges', () => {
  it('reads only the ledger columns granted to integration apps', () => {
    const reader = readFileSync(
      new URL(
        '../../apps/farm/server/utils/integration-resin-postgres.ts',
        import.meta.url,
      ),
      'utf8',
    )
    const grant = readFileSync(
      new URL(
        '../../infra/db/migrations/0099_integration_resin_reads.up.sql',
        import.meta.url,
      ),
      'utf8',
    )
    expect(reader).toContain('FROM farm.resin_ledger_entries e')
    expect(reader).not.toContain('SELECT e.*')
    expect(grant).toMatch(
      /GRANT SELECT \(farm_id, id, printer_id, kind, target, name, volume_ml, layers, hours, source, recorded_at\)\s+ON farm\.resin_ledger_entries TO farm_integration_apps/,
    )
    expect(grant).not.toContain('recorded_by')
  })
})
