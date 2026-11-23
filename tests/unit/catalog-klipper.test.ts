import { describe, expect, it } from 'vitest'
import {
  capabilityStatusLabels,
  compatibilityCatalog,
  compatibilityPageCatalog,
  filterCompatibility,
  klipperCatalog,
  klipperFamilyIds,
} from '../../apps/farm/app/utils/compatibility/index'

const keys = [
  'id',
  'brand',
  'model',
  'releaseStatus',
  'releaseDate',
  'firmwareStatus',
  'firmwareNotes',
  'connection',
  'capabilities',
  'controlAreas',
  'controlAreaEvidence',
  'sources',
  'limitations',
]
const capabilityKeys = [
  'telemetry',
  'files',
  'camera',
  'materials',
  'pause',
  'resume',
  'cancel',
]

describe('catálogo Klipper/Moonraker', () => {
  it('segue o contrato de registro com ids únicos', () => {
    expect(klipperCatalog).toHaveLength(5)
    expect(new Set(klipperCatalog.map((p) => p.id)).size).toBe(5)
    for (const product of klipperCatalog) {
      // `hardwareReports` is optional: present only where hardware was qualified.
      expect(
        Object.keys(product)
          .filter((key) => key !== 'hardwareReports')
          .sort(),
      ).toEqual([...keys].sort())
      expect(Object.keys(product.capabilities).sort()).toEqual(
        [...capabilityKeys].sort(),
      )
      expect(product.id).toMatch(/^[a-z0-9-]+$/)
      expect(
        product.releaseDate === null ||
          /^\d{4}-\d{2}-\d{2}$/.test(product.releaseDate),
      ).toBe(true)
      expect(product.limitations.length).toBeGreaterThan(0)
      expect(product.sources.every((s) => s.startsWith('https://'))).toBe(true)
    }
  })

  it('cobre genérico, K1 com root, kit Voron e Sovol', () => {
    expect(klipperCatalog.map((p) => p.id)).toEqual([
      'klipper-generic-moonraker',
      'creality-k1-series-moonraker-root',
      'voron-2-4-kit',
      'sovol-sv08',
      'voron-trident-kit',
    ])
    expect(klipperCatalog.map((p) => p.brand)).toEqual([
      'Klipper',
      'Creality',
      'Voron Design',
      'Sovol',
      'Voron Design',
    ])
  })

  it('usa os status decididos e nunca documented sem fonte', () => {
    for (const product of klipperCatalog) {
      const c = product.capabilities
      // Only the generic entry has recorded hardware qualification reports.
      expect(c.telemetry).toBe(
        product.id === 'klipper-generic-moonraker' ? 'hardware' : 'simulated',
      )
      expect(c.pause).toBe('simulated')
      expect(c.resume).toBe('simulated')
      expect(c.cancel).toBe('simulated')
      expect(c.camera).toBe(
        product.id === 'klipper-generic-moonraker' ? 'hardware' : 'simulated',
      )
      // `createFileTargets` never builds a Moonraker file target, so file
      // listing and upload stay unreachable for the whole family.
      expect(c.files).toBe('unknown')
      // Materials come from the configured Spoolman mirror: the active spool
      // reaches the Moonraker snapshot, so the status is no longer unknown.
      expect(c.materials).not.toBe('unknown')
      expect(c.materials).toBe('simulated')
      for (const status of Object.values(c)) {
        expect(capabilityStatusLabels[status]).toBeTruthy()
        if (status === 'documented')
          expect(product.sources.length).toBeGreaterThan(0)
      }
      expect(product.limitations.join(' ')).toMatch(/simuladores/)
      expect(product.limitations.join(' ')).toMatch(/não habilita comandos/)
    }
  })

  it('não altera o catálogo existente e expõe a família na página', () => {
    expect(compatibilityCatalog.some((p) => klipperFamilyIds.has(p.id))).toBe(
      false,
    )
    expect(compatibilityPageCatalog).toEqual([
      ...compatibilityCatalog,
      ...klipperCatalog,
    ])
    expect(
      filterCompatibility('voron', compatibilityPageCatalog).map((p) => p.id),
    ).toEqual(['voron-2-4-kit', 'voron-trident-kit'])
  })
})
