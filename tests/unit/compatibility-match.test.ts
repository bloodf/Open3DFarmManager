import { describe, expect, it } from 'vitest'
import {
  compatibilityPageCatalog,
  capabilityStatusLabels,
} from '../../apps/farm/app/utils/compatibility/index'
import {
  matchCatalogProduct,
  matchCompatibility,
  UNIDENTIFIED_LABEL,
} from '../../apps/farm/app/utils/compatibility/match'

describe('compatibility-match', () => {
  describe('catalog coverage: every entry in compatibilityPageCatalog is matched', () => {
    it('matches every catalog entry by its exact id', () => {
      expect(compatibilityPageCatalog.length).toBe(21)
      for (const product of compatibilityPageCatalog) {
        const match = matchCompatibility({ model: product.id })
        expect(match.identified).toBe(true)
        if (match.identified) {
          expect(match.product.id).toBe(product.id)
          expect(match.product.brand).toBe(product.brand)
          expect(match.product.model).toBe(product.model)
          expect(match.label).toBe(`${product.brand} ${product.model}`)
          expect(match.capabilityStatuses).toEqual(product.capabilities)
          for (const [capKey, status] of Object.entries(
            match.capabilityStatuses,
          )) {
            expect(
              match.statusLabels[capKey as keyof typeof match.statusLabels],
            ).toBe(capabilityStatusLabels[status])
          }
        }
      }
    })

    it('matches every catalog entry by vendor and model', () => {
      for (const product of compatibilityPageCatalog) {
        const match = matchCompatibility({
          vendor: product.brand,
          model: product.model,
          firmware: '1.0.0',
        })
        expect(match.identified).toBe(true)
        if (match.identified) {
          expect(match.product.id).toBe(product.id)
          expect(match.capabilityStatuses).toEqual(product.capabilities)
        }
      }
    })
  })

  describe('Anycubic models', () => {
    it.each([
      ['Kobra 3 Max V2', 'anycubic-kobra-3-max-v2'],
      ['Kobra 4', 'anycubic-kobra-4'],
      ['Kobra X', 'anycubic-kobra-x'],
      ['Kobra S1 Max', 'anycubic-kobra-s1-max'],
      ['Kobra 3 V2', 'anycubic-kobra-3-v2'],
    ])('matches Anycubic %s with normalization', (modelName, expectedId) => {
      // With vendor
      const withVendor = matchCompatibility({
        vendor: 'Anycubic',
        model: modelName,
      })
      expect(withVendor.identified).toBe(true)
      if (withVendor.identified) {
        expect(withVendor.product.id).toBe(expectedId)
      }

      // Case and space variations
      const variation = matchCompatibility({
        vendor: 'anycubic',
        model: `  ${modelName.toLowerCase()}  `,
      })
      expect(variation.identified).toBe(true)
      if (variation.identified) {
        expect(variation.product.id).toBe(expectedId)
      }

      // Without vendor but with brand prefix in model
      const prefixed = matchCompatibility({ model: `Anycubic ${modelName}` })
      expect(prefixed.identified).toBe(true)
      if (prefixed.identified) {
        expect(prefixed.product.id).toBe(expectedId)
      }
    })
  })

  describe('Bambu Lab models and codes', () => {
    it.each([
      ['A2L', 'bambu-a2l'],
      ['X2D', 'bambu-x2d'],
      ['H2C', 'bambu-h2c'],
      ['P2S', 'bambu-p2s'],
      ['H2S', 'bambu-h2s'],
    ])(
      'matches Bambu %s across name and code variations',
      (modelCode, expectedId) => {
        // Standard uppercase with vendor
        expect(
          matchCatalogProduct({ vendor: 'Bambu Lab', model: modelCode })?.id,
        ).toBe(expectedId)
        expect(
          matchCatalogProduct({
            vendor: 'bambu',
            model: modelCode.toLowerCase(),
          })?.id,
        ).toBe(expectedId)

        // With 'Bambu Lab' prefix in model
        expect(
          matchCatalogProduct({ model: `Bambu Lab ${modelCode}` })?.id,
        ).toBe(expectedId)
        expect(matchCatalogProduct({ model: `Bambu ${modelCode}` })?.id).toBe(
          expectedId,
        )
        expect(
          matchCatalogProduct({ model: `bambulab ${modelCode.toLowerCase()}` })
            ?.id,
        ).toBe(expectedId)

        // Model codes (BL-*, bambu-*, hyphens, spaces)
        expect(
          matchCatalogProduct({ vendor: 'bambu', model: `BL-${modelCode}` })
            ?.id,
        ).toBe(expectedId)
        expect(matchCatalogProduct({ model: `BL-${modelCode}` })?.id).toBe(
          expectedId,
        )
        expect(
          matchCatalogProduct({ model: `bambu-${modelCode.toLowerCase()}` })
            ?.id,
        ).toBe(expectedId)
        expect(
          matchCatalogProduct({ vendor: 'bambu', model: `  ${modelCode}  ` })
            ?.id,
        ).toBe(expectedId)
      },
    )

    it('correctly maps capability statuses for Bambu models', () => {
      const match = matchCompatibility({
        vendor: 'Bambu Lab',
        model: 'P2S',
        firmware: '01.07.00.00',
      })
      expect(match.identified).toBe(true)
      if (match.identified) {
        expect(match.product.id).toBe('bambu-p2s')
        expect(match.capabilityStatuses.telemetry).toBe('simulated')
        expect(match.statusLabels.telemetry).toBe('Simulado')
      }
    })
  })

  describe('Creality stock models', () => {
    it.each([
      ['mBox', 'creality-mbox'],
      ['Ender-3 V3 Neo', 'creality-ender-3-v3-neo'],
      ['Ender-3 V3 Mega', 'creality-ender-3-v3-mega'],
      ['K3', 'creality-k3'],
      ['Ender-3 V4', 'creality-ender-3-v4'],
    ])('matches Creality %s with normalization', (modelName, expectedId) => {
      expect(
        matchCatalogProduct({ vendor: 'Creality', model: modelName })?.id,
      ).toBe(expectedId)
      expect(
        matchCatalogProduct({
          vendor: 'creality',
          model: modelName.toLowerCase(),
        })?.id,
      ).toBe(expectedId)
      expect(matchCatalogProduct({ model: `Creality ${modelName}` })?.id).toBe(
        expectedId,
      )
    })

    it('preserves files documented status for Ender-3 V3 Mega', () => {
      const match = matchCompatibility({
        vendor: 'Creality',
        model: 'Ender-3 V3 Mega',
      })
      expect(match.identified).toBe(true)
      if (match.identified) {
        expect(match.capabilityStatuses.files).toBe('documented')
        expect(match.statusLabels.files).toBe('Documentado')
      }
    })
  })

  describe('Klipper and Moonraker family', () => {
    it('matches Creality K1 series via Moonraker root', () => {
      const candidates = [
        { vendor: 'Creality', model: 'K1' },
        { vendor: 'creality', model: 'k1c' },
        { vendor: 'Creality', model: 'K1 Max' },
        { vendor: 'moonraker', model: 'K1' },
        { vendor: 'moonraker', model: 'K1 Max' },
        { model: 'Creality K1 Max' },
        {
          model: 'Série K1 (K1, K1C, K1 Max) com Klipper e Moonraker via root',
        },
        { model: 'creality-k1-series-moonraker-root' },
      ]
      for (const candidate of candidates) {
        const match = matchCompatibility(candidate)
        expect(match.identified).toBe(true)
        if (match.identified) {
          expect(match.product.id).toBe('creality-k1-series-moonraker-root')
          expect(match.capabilityStatuses.telemetry).toBe('simulated')
          expect(match.capabilityStatuses.pause).toBe('simulated')
          expect(match.statusLabels.telemetry).toBe('Simulado')
        }
      }
    })

    it('matches Sovol SV08', () => {
      const candidates = [
        { vendor: 'Sovol', model: 'SV08' },
        { vendor: 'sovol', model: 'sv08' },
        { vendor: 'moonraker', model: 'SV08' },
        { model: 'Sovol SV08' },
        { model: 'sovol-sv08' },
      ]
      for (const candidate of candidates) {
        const match = matchCompatibility(candidate)
        expect(match.identified).toBe(true)
        if (match.identified) {
          expect(match.product.id).toBe('sovol-sv08')
          expect(match.capabilityStatuses.pause).toBe('simulated')
        }
      }
    })

    it('matches Voron 2.4', () => {
      const candidates = [
        {
          vendor: 'Voron Design',
          model: 'Voron 2.4 (kit de montagem própria)',
        },
        { vendor: 'Voron', model: '2.4' },
        { vendor: 'moonraker', model: 'Voron 2.4' },
        { model: 'Voron 2.4' },
        { model: 'voron-2-4-kit' },
      ]
      for (const candidate of candidates) {
        const match = matchCompatibility(candidate)
        expect(match.identified).toBe(true)
        if (match.identified) {
          expect(match.product.id).toBe('voron-2-4-kit')
          expect(match.capabilityStatuses.telemetry).toBe('simulated')
        }
      }
    })

    it('matches generic Klipper + Moonraker', () => {
      const candidates = [
        { vendor: 'Klipper', model: 'Klipper + Moonraker genérico' },
        { vendor: 'klipper', model: 'generic' },
        { vendor: 'moonraker', model: 'generic' },
        { vendor: 'moonraker', model: 'klipper' },
        { vendor: 'moonraker' },
        { vendor: 'klipper' },
        { model: 'klipper-generic-moonraker' },
        { model: 'Klipper + Moonraker genérico' },
      ]
      for (const candidate of candidates) {
        const match = matchCompatibility(candidate)
        expect(match.identified).toBe(true)
        if (match.identified) {
          expect(match.product.id).toBe('klipper-generic-moonraker')
          expect(match.capabilityStatuses.telemetry).toBe('simulated')
          expect(match.capabilityStatuses.pause).toBe('simulated')
        }
      }
    })
  })

  describe('unknowns: returns não identificado', () => {
    it.each([
      [null],
      [undefined],
      [{ vendor: null, model: null, firmware: null }],
      [{ vendor: '', model: '' }],
      [{ vendor: '   ', model: '   ' }],
      [{ vendor: 'Prusa', model: 'MK4' }],
      [{ vendor: 'Ultimaker', model: 'S5' }],
      [{ vendor: 'Bambu Lab', model: 'BL-P001' }],
      [{ vendor: 'bambu', model: 'unknown-code' }],
      [{ vendor: 'bambu', model: 'X1-Carbon' }],
      [{ vendor: 'bambu', model: 'A1-Mini' }],
      [{ vendor: 'Creality', model: 'Ender 3 V2' }],
      [{ vendor: 'Creality', model: 'CR-10 SE' }],
      [{ vendor: 'Creality', model: 'K2 Plus' }],
      [{ vendor: 'Anycubic', model: 'Mega S' }],
      [{ vendor: 'Anycubic', model: 'Chiron' }],
      [{ vendor: 'Anycubic', model: 'Vyper' }],
      [{ vendor: 'Sovol', model: 'SV06' }],
      [{ vendor: 'Voron', model: '0.2' }],
      [{ vendor: 'moonraker', model: 'Custom Unknown Model' }],
      [{ model: 'Custom XYZ Printer' }],
    ])('returns não identificado for %j', (observed) => {
      const product = matchCatalogProduct(observed)
      expect(product).toBeNull()

      const match = matchCompatibility(observed)
      expect(match.identified).toBe(false)
      expect(match.product).toBeNull()
      expect(match.label).toBe(UNIDENTIFIED_LABEL)
      expect(match.label).toBe('não identificado')
      expect(match.capabilityStatuses).toBeNull()
      expect(match.statusLabels).toBeNull()
      expect(match.brand).toBeNull()
      expect(match.model).toBeNull()
    })

    it('rejects conflicting vendor and model combinations', () => {
      expect(
        matchCatalogProduct({ vendor: 'Anycubic', model: 'P2S' }),
      ).toBeNull()
      expect(
        matchCatalogProduct({ vendor: 'Bambu Lab', model: 'Kobra X' }),
      ).toBeNull()
      expect(
        matchCatalogProduct({ vendor: 'Creality', model: 'A2L' }),
      ).toBeNull()
      expect(
        matchCatalogProduct({ vendor: 'Sovol', model: 'Kobra 4' }),
      ).toBeNull()
      expect(matchCatalogProduct({ vendor: 'Voron', model: 'mBox' })).toBeNull()
    })
  })
})
