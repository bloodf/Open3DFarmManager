import { describe, expect, it } from 'vitest'
import {
  compatibilityPageCatalog,
  filterCompatibility,
} from '../../apps/farm/app/utils/compatibility/index'
import type { AnycubicCatalogProduct } from '../../apps/farm/app/utils/compatibility/anycubic'

describe('catalog firmware notes', () => {
  it('keeps existing entries valid without notes', () => {
    expect(compatibilityPageCatalog.length).toBeGreaterThan(0)
    expect(
      compatibilityPageCatalog.every(
        (product) => product.firmwareNotes === undefined,
      ),
    ).toBe(true)
  })

  it('preserves separate firmware notes for each model during search', () => {
    const base = compatibilityPageCatalog[0]!
    const products: AnycubicCatalogProduct[] = [
      {
        ...base,
        id: 'one',
        model: 'Model One',
        firmwareNotes: [
          { firmware: '1.0', note: 'Nota da versão 1' },
          { firmware: '2.0', note: 'Nota da versão 2' },
        ],
      },
      {
        ...base,
        id: 'two',
        model: 'Model Two',
        firmwareNotes: [{ firmware: '1.0', note: 'Outra nota' }],
      },
    ]
    expect(
      filterCompatibility('Model One', products)[0]?.firmwareNotes,
    ).toEqual([
      { firmware: '1.0', note: 'Nota da versão 1' },
      { firmware: '2.0', note: 'Nota da versão 2' },
    ])
    expect(
      filterCompatibility('Model Two', products)[0]?.firmwareNotes,
    ).toEqual([{ firmware: '1.0', note: 'Outra nota' }])
  })
})
