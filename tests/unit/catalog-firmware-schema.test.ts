import { describe, expect, it } from 'vitest'
import {
  compatibilityPageCatalog,
  filterCompatibility,
} from '../../apps/farm/app/utils/compatibility/index'
import type { AnycubicCatalogProduct } from '../../apps/farm/app/utils/compatibility/anycubic'

describe('catalog firmware notes', () => {
  it('keeps entries without notes valid alongside documented firmware', () => {
    expect(compatibilityPageCatalog.length).toBeGreaterThan(0)
    // Notes stay optional on the catalog type: every current product carries
    // one, but a product built without the key must still type-check.
    const { firmwareNotes: _omitted, ...withoutNotes } =
      compatibilityPageCatalog[0]!
    const product: AnycubicCatalogProduct = withoutNotes
    expect(product.firmwareNotes).toBeUndefined()
  })

  it('preserves separate firmware notes for each model during search', () => {
    const base = compatibilityPageCatalog[0]!
    const products: AnycubicCatalogProduct[] = [
      {
        ...base,
        id: 'one',
        model: 'Model One',
        firmwareNotes: [
          {
            firmware: '1.0',
            note: 'Nota da versão 1',
            sources: ['https://example.com/1'],
          },
          {
            firmware: '2.0',
            note: 'Nota da versão 2',
            sources: ['https://example.com/2'],
          },
        ],
      },
      {
        ...base,
        id: 'two',
        model: 'Model Two',
        firmwareNotes: [
          {
            firmware: '1.0',
            note: 'Outra nota',
            sources: ['https://example.com/3'],
          },
        ],
      },
    ]
    expect(
      filterCompatibility('Model One', products)[0]?.firmwareNotes,
    ).toEqual([
      {
        firmware: '1.0',
        note: 'Nota da versão 1',
        sources: ['https://example.com/1'],
      },
      {
        firmware: '2.0',
        note: 'Nota da versão 2',
        sources: ['https://example.com/2'],
      },
    ])
    expect(
      filterCompatibility('Model Two', products)[0]?.firmwareNotes,
    ).toEqual([
      {
        firmware: '1.0',
        note: 'Outra nota',
        sources: ['https://example.com/3'],
      },
    ])
  })
})
