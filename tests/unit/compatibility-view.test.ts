import { describe, expect, it } from 'vitest'
import {
  capabilityStatusLabels,
  compatibilityCatalog,
  filterCompatibility,
} from '../../apps/farm/app/utils/compatibility/index'

describe('compatibility catalog view', () => {
  it('searches brands and models without case or surrounding whitespace', () => {
    expect(
      filterCompatibility('  aNYcUBIC kobra x ').map((product) => product.id),
    ).toEqual(['anycubic-kobra-x'])
    expect(
      filterCompatibility('Bambu Lab').every(
        (product) => product.brand === 'Bambu Lab',
      ),
    ).toBe(true)
    expect(filterCompatibility('sem correspondência')).toEqual([])
  })
  it('includes the three catalogs and labels every capability status', () => {
    expect(
      new Set(compatibilityCatalog.map((product) => product.brand)),
    ).toEqual(new Set(['Anycubic', 'Bambu Lab', 'Creality']))
    for (const product of compatibilityCatalog) {
      expect(product.sources.length).toBeGreaterThan(0)
      for (const status of Object.values(product.capabilities))
        expect(capabilityStatusLabels[status]).toBeTruthy()
    }
    expect(capabilityStatusLabels).toEqual({
      documented: 'Documentado',
      simulated: 'Simulado',
      unknown: 'Desconhecido',
      unsupported: 'Não suportado',
    })
  })
})
