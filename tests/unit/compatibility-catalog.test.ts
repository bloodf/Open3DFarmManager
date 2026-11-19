import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { anycubicCatalog } from '../../apps/farm/app/utils/compatibility/anycubic'
import { bambuCatalog } from '../../apps/farm/app/utils/compatibility/bambu'
import { crealityCatalog } from '../../apps/farm/app/utils/compatibility/creality'
import { klipperCatalog } from '../../apps/farm/app/utils/compatibility/klipper'
import { lanCatalog } from '../../apps/farm/app/utils/compatibility/lan'
import {
  controlAreaKeys,
  controlAreaLabels,
} from '../../apps/farm/app/utils/compatibility/control-areas'
import { capabilityStatusLabels } from '../../apps/farm/app/utils/compatibility/index'

const families = {
  anycubic: anycubicCatalog,
  bambu: bambuCatalog,
  creality: crealityCatalog,
  klipper: klipperCatalog,
  lan: lanCatalog,
} as const
const root = resolve(import.meta.dirname, '../..')

describe('áreas de controle do catálogo', () => {
  it('declara as 19 áreas exigidas, cada uma com rótulo pt-BR', () => {
    expect([...controlAreaKeys].sort()).toEqual(
      [
        'temperatures',
        'motion',
        'extrusion',
        'fans',
        'leds',
        'macros',
        'console',
        'printStatus',
        'excludeObject',
        'jobQueue',
        'fileManager',
        'webcams',
        'bedMesh',
        'config',
        'services',
        'history',
        'timelapse',
        'power',
        'updates',
      ].sort(),
    )
    for (const key of controlAreaKeys)
      expect(controlAreaLabels[key]).toBeTruthy()
  })

  it.each(Object.entries(families))(
    'toda entrada da família %s tem todas as chaves com status válido',
    (_family, products) => {
      for (const product of products) {
        expect(Object.keys(product.controlAreas).sort(), product.id).toEqual(
          [...controlAreaKeys].sort(),
        )
        for (const key of controlAreaKeys)
          expect(capabilityStatusLabels[product.controlAreas[key]]).toBeTruthy()
      }
    },
  )

  it('mantém desconhecidas as famílias que não são Klipper até o E22', () => {
    for (const products of [
      anycubicCatalog,
      bambuCatalog,
      crealityCatalog,
      lanCatalog,
    ])
      for (const product of products)
        for (const key of controlAreaKeys)
          expect(product.controlAreas[key], `${product.id}.${key}`).toBe(
            'unknown',
          )
  })

  it('não aceita simulado sem referência a teste em simulador existente', () => {
    for (const products of Object.values(families))
      for (const product of products)
        for (const key of controlAreaKeys) {
          if (product.controlAreas[key] !== 'simulated') {
            expect(
              product.controlAreaEvidence?.[key],
              `${product.id}.${key}`,
            ).toBeUndefined()
            continue
          }
          const evidence = product.controlAreaEvidence?.[key]
          expect(
            evidence,
            `${product.id}.${key} simulado sem teste`,
          ).toBeDefined()
          const path = resolve(root, evidence!.file)
          expect(existsSync(path), evidence!.file).toBe(true)
          expect(readFileSync(path, 'utf8'), `${product.id}.${key}`).toContain(
            evidence!.test,
          )
        }
  })

  it('preenche a família Klipper onde há teste e mantém o resto desconhecido', () => {
    for (const product of klipperCatalog) {
      expect(product.controlAreas.temperatures).toBe('simulated')
      expect(product.controlAreas.jobQueue).toBe('simulated')
      expect(product.controlAreas.extrusion).toBe('unknown')
      expect(product.controlAreas.config).toBe('unknown')
      expect(product.limitations.join(' ')).toMatch(/nunca em hardware/)
    }
  })
})
