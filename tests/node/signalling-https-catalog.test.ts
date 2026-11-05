import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrationCatalog } from '../../scripts/db/migrations.ts'
import { assertSignallingCatalog } from '../helpers/signalling-https-catalog.ts'

test('RTC fixture requires the entire actual catalog while historical mode stays at 17', () => {
  const sources = Array.from({ length: 18 }, (_, index) => {
    const id = `${String(index + 1).padStart(4, '0')}_${index === 16 ? 'signalling_authorization' : 'synthetic'}`
    return [
      { name: `${id}.up.sql`, sql: 'SELECT 1' },
      { name: `${id}.down.sql`, sql: 'SELECT 2' },
    ]
  }).flat()
  const catalog = migrationCatalog(sources)
  const history = catalog.map((item, index) => ({
    position: index + 1,
    id: item.id,
    checksum: item.checksum,
  }))
  assert.equal(assertSignallingCatalog(catalog, history, true), 18)
  assert.throws(() =>
    assertSignallingCatalog(catalog, history.slice(0, 17), true),
  )
  assert.throws(() => assertSignallingCatalog(catalog, history, false))
  assert.equal(
    assertSignallingCatalog(catalog.slice(0, 17), history.slice(0, 17), false),
    17,
  )
  assert.throws(() =>
    assertSignallingCatalog(
      catalog,
      history.map((row, index) =>
        index === 17 ? { ...row, checksum: 'bad' } : row,
      ),
      true,
    ),
  )
  assert.throws(() =>
    assertSignallingCatalog(catalog, [...history, history[0]], true),
  )
})
