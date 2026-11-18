import { describe, expect, it } from 'vitest'
import { bambuCatalog } from '../../apps/farm/app/utils/compatibility/bambu'

describe('Bambu catalog', () => {
  it('lists five distinct base models with useful labels and primary sources', () => {
    expect(bambuCatalog.map((product) => product.model)).toEqual([
      'A2L',
      'X2D',
      'H2C',
      'P2S',
      'H2S',
    ])
    expect(new Set(bambuCatalog.map((product) => product.id)).size).toBe(5)
    for (const product of bambuCatalog) {
      expect(product.brand).toBe('Bambu Lab')
      expect(product.releaseStatus).toContain('Anunciada')
      expect(product.sources[0]).toMatch(/^https:\/\/blog\.bambulab\.com\//)
      expect(product.limitations.length).toBeGreaterThan(0)
    }
  })

  it('does not infer integration or firmware support from announcements', () => {
    for (const product of bambuCatalog) {
      // O rótulo antigo de firmware desconhecido foi substituído pelo rótulo
      // explícito de versão não verificada.
      expect(product.firmwareStatus).toContain('não verificado')
      expect(product.firmwareStatus).not.toContain('Desconhecido')
      expect(product.capabilities).toEqual({
        telemetry: 'simulated',
        // FTPS listing and upload are implemented and exercised against the
        // Bambu simulator.
        files: 'simulated',
        camera: ['H2C', 'P2S', 'H2S'].includes(product.model)
          ? 'simulated'
          : 'unknown',
        // AMS tray reading and load/unload commands are covered by tests, so
        // materials is no longer unknown.
        materials: 'simulated',
        pause: 'simulated',
        resume: 'simulated',
        cancel: 'simulated',
      })
      // Materiais deixou de ser desconhecido: a leitura de bandejas AMS e os
      // comandos de carga e descarga são exercitados contra o simulador.
      expect(product.capabilities.materials).not.toBe('unknown')
      expect(product.capabilities.materials).toBe('simulated')
      for (const status of Object.values(product.capabilities)) {
        if (status === 'documented')
          expect(product.sources.length).toBeGreaterThan(0)
        if (status === 'simulated')
          expect(product.limitations.length).toBeGreaterThan(0)
      }
    }
  })
})
