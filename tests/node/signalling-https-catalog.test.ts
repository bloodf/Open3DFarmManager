import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrationCatalog } from '../../scripts/db/migrations.ts'
import { assertSignallingCatalog } from '../helpers/signalling-https-catalog.ts'

test('every fixture mode requires the entire actual catalog with signalling authorization present', () => {
  const sources = Array.from({ length: 24 }, (_, index) => {
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
  // Later migrations no longer break the read-only acceptance row.
  assert.equal(assertSignallingCatalog(catalog, history), 24)
  assert.throws(() => assertSignallingCatalog(catalog, history.slice(0, 17)))
  assert.throws(() =>
    assertSignallingCatalog(catalog.slice(0, 16), history.slice(0, 16)),
  )
  assert.throws(() =>
    assertSignallingCatalog(
      catalog,
      history.map((row, index) =>
        index === 17 ? { ...row, checksum: 'bad' } : row,
      ),
    ),
  )
  assert.throws(() =>
    assertSignallingCatalog(catalog, [...history, history[0]]),
  )
})
