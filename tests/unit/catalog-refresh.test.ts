import { describe, expect, it } from 'vitest'
import { bambuCatalog } from '../../apps/farm/app/utils/compatibility/bambu'
import { anycubicCatalog } from '../../apps/farm/app/utils/compatibility/anycubic'
import { crealityCatalog } from '../../apps/farm/app/utils/compatibility/creality'
import { klipperCatalog } from '../../apps/farm/app/utils/compatibility/klipper'

describe('catálogo atualizado', () => {
  it('reflete as rotas simuladas de Bambu e KobraLink', () => {
    for (const product of bambuCatalog) {
      for (const capability of [
        'telemetry',
        'files',
        'pause',
        'resume',
        'cancel',
      ] as const)
        expect(product.capabilities[capability]).toBe('simulated')
      expect(product.capabilities.camera).toBe(
        ['H2C', 'P2S', 'H2S'].includes(product.model) ? 'simulated' : 'unknown',
      )
    }
    const kobra = anycubicCatalog.find(
      (product) => product.id === 'anycubic-kobra-x',
    )!
    for (const capability of [
      'telemetry',
      'pause',
      'resume',
      'cancel',
    ] as const)
      expect(kobra.capabilities[capability]).toBe('simulated')
  })
  it('expõe limitações para simulações', () => {
    for (const product of [
      ...bambuCatalog,
      ...anycubicCatalog,
      ...crealityCatalog,
      ...klipperCatalog,
    ])
      if (Object.values(product.capabilities).includes('simulated'))
        expect(product.limitations.length).toBeGreaterThan(0)
  })
})
