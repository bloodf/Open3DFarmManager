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
      expect(product.firmwareStatus).toContain('não verificado')
      expect(product.capabilities).toEqual({
        telemetry: 'simulated',
        // FTPS listing and upload are implemented and tested, but no
        // collection configuration builds a Bambu file target.
        files: 'unknown',
        camera: ['H2C', 'P2S', 'H2S'].includes(product.model)
          ? 'simulated'
          : 'unknown',
        // AMS tray reading and load/unload commands are covered by tests.
        materials: 'simulated',
        pause: 'simulated',
        resume: 'simulated',
        cancel: 'simulated',
      })
      for (const status of Object.values(product.capabilities)) {
        if (status === 'documented')
          expect(product.sources.length).toBeGreaterThan(0)
        if (status === 'simulated')
          expect(product.limitations.length).toBeGreaterThan(0)
      }
    }
  })
})
