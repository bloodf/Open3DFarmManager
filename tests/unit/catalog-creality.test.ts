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

      // K3 declares Klipper base, but does not claim proven Moonraker interface
      if (product.model === 'K3') {
        expect(product.capabilities.pause).toBe('unknown')
        expect(product.capabilities.resume).toBe('unknown')
        expect(product.capabilities.cancel).toBe('unknown')
      }

      // Ender-3 V3 Mega documents file transfer via USB/Wi-Fi/Cloud, while unverified methods remain unknown
      if (product.model === 'Ender-3 V3 Mega') {
        expect(product.capabilities.files).toBe('documented')
        expect(product.capabilities.pause).toBe('unknown')
        expect(product.capabilities.resume).toBe('unknown')
        expect(product.capabilities.cancel).toBe('unknown')
      } else {
        expect(product.capabilities.files).toBe('unknown')
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
