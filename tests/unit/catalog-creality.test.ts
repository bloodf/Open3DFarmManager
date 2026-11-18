import { describe, expect, it } from 'vitest'
import {
  crealityCatalog,
  type CatalogCapability,
  type CrealityCatalogProduct,
} from '../../apps/farm/app/utils/compatibility/creality'

describe('catálogo Creality', () => {
  it('exporta cinco modelos base FDM distintos com rótulos úteis e identificadores únicos', () => {
    expect(crealityCatalog).toHaveLength(5)

    const ids = crealityCatalog.map((product) => product.id)
    const models = crealityCatalog.map((product) => product.model)

    expect(new Set(ids).size).toBe(5)
    expect(new Set(models).size).toBe(5)
    expect(models).toEqual([
      'mBox',
      'Ender-3 V3 Neo',
      'Ender-3 V3 Mega',
      'K3',
      'Ender-3 V4',
    ])

    for (const product of crealityCatalog) {
      expect(product.brand).toBe('Creality')
      expect(product.id).toMatch(/^creality-[a-z0-9-]+$/)
      expect(product.model.length).toBeGreaterThan(0)
      expect(product.releaseStatus.length).toBeGreaterThan(15)
      expect(product.firmwareStatus.length).toBeGreaterThan(10)
      expect(product.connection.length).toBeGreaterThan(10)
      expect(product.limitations.length).toBeGreaterThan(0)
      expect(product.sources.length).toBeGreaterThan(0)
      expect(product.sources.every((src) => src.startsWith('https://'))).toBe(
        true,
      )
    }
  })

  it('mantém alegações conservadoras sem suporte inventado a hardware ou firmware', () => {
    const validStatuses: CatalogCapability[] = [
      'documented',
      'simulated',
      'unknown',
      'unsupported',
    ]

    for (const product of crealityCatalog) {
      // Never use permission as capability
      for (const [key, value] of Object.entries(product.capabilities)) {
        expect(validStatuses).toContain(value)
        expect(value).not.toBe('permission')
      }

      // The Creality driver is model-agnostic (`CrealityBinding` has no model
      // field and `supportedCrealityActions` ignores its argument), so the
      // stock LAN path covers the whole family the same way.
      for (const product of crealityCatalog) {
        expect(product.capabilities.telemetry).toBe('simulated')
        expect(product.capabilities.files).toBe('simulated')
        expect(product.capabilities.pause).toBe('simulated')
        expect(product.capabilities.resume).toBe('simulated')
        expect(product.capabilities.cancel).toBe('simulated')
        // The camera module is not wired into the agent configuration path.
        expect(product.capabilities.camera).toBe('unknown')
        // The connector refuses undocumented filament commands outright.
        expect(product.capabilities.materials).toBe('unsupported')
      }

      // Ender-3 V4 release date is unconfirmed
      if (product.model === 'Ender-3 V4') {
        expect(product.releaseDate).toBeNull()
        expect(
          product.limitations.some(
            (l) => l.includes('quinta posição') || l.includes('disputa'),
          ),
        ).toBe(true)
      }

      // Limitations are pt-BR strings
      for (const limitation of product.limitations) {
        expect(typeof limitation).toBe('string')
        expect(limitation.length).toBeGreaterThan(10)
      }
    }
  })

  it('não duplica pacotes Combo ou acessórios como modelos base separados', () => {
    const models = crealityCatalog.map((product) => product.model)
    expect(models.some((m) => m.toLowerCase().includes('combo'))).toBe(false)
    expect(models.some((m) => m.toLowerCase().includes('cfs'))).toBe(false)
  })
})
