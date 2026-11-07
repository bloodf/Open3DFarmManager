import { describe, expect, test } from 'vitest'
import { loadMigrationCatalog } from '../../scripts/db/migrations.ts'
import { validatePairingHttpCatalog } from '../../scripts/db/pairing-http-catalog.ts'

describe('pairing HTTP migration fixture', () => {
  test('accepts exact prefix while rejecting missing, mismatched and extra journal entries', async () => {
    const catalog = await loadMigrationCatalog()
    const prefix = catalog.slice(0, 16)
    const history = prefix.map((entry, index) => ({
      position: index + 1,
      id: entry.id,
      checksum: entry.checksum,
    }))
    expect(() => validatePairingHttpCatalog(catalog, history)).not.toThrow()
    expect(() =>
      validatePairingHttpCatalog(catalog, history.slice(0, 15)),
    ).toThrow()
    expect(() =>
      validatePairingHttpCatalog(
        catalog,
        history.map((row, index) =>
          index === 3 ? { ...row, checksum: '0'.repeat(64) } : row,
        ),
      ),
    ).toThrow()
    expect(() =>
      validatePairingHttpCatalog(catalog, [
        ...history,
        { position: 17, id: '0017_extra', checksum: '0'.repeat(64) },
      ]),
    ).toThrow()
    expect(() =>
      validatePairingHttpCatalog(catalog.slice(0, 15), history),
    ).toThrow()
  })
})
