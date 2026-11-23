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
      // A listagem e o envio por FTPS passivo foram exercitados contra o
      // simulador; o alvo de arquivos da coleção Bambu ainda não é montado
      // pela configuração de coleta, e isso fica na limitação.
      expect(product.capabilities.files).toBe('simulated')
      expect(product.capabilities.camera).toBe('unknown')
      // Materiais seguem o espelho AMS decodificado pelo conector.
      expect(product.capabilities.materials).toBe('simulated')
    }
    const kobra = anycubicCatalog.find(
      (product) => product.id === 'anycubic-kobra-x',
    )!
    // Telemetry is hardware-proven from a real Kobra X; commands stay simulated.
    expect(kobra.capabilities.telemetry).toBe('hardware')
    for (const capability of ['pause', 'resume', 'cancel'] as const)
      expect(kobra.capabilities[capability]).toBe('simulated')
    // A ponte KobraLink monta alvo de arquivos, então a listagem é alcançável.
    expect(kobra.capabilities.files).toBe('simulated')
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
