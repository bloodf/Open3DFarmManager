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

  it('mantém desconhecidas as famílias que ainda não têm o E22', () => {
    for (const products of [anycubicCatalog, lanCatalog])
      for (const product of products) {
        if (
          product.id === 'anycubic-kobra-x' ||
          product.id === 'anycubic-kobra-3-lan'
        )
          continue
        for (const key of controlAreaKeys)
          expect(product.controlAreas[key], `${product.id}.${key}`).toBe(
            'unknown',
          )
      }
  })

  it('documenta as áreas da Kobra X e da Anycubic LAN do #444', () => {
    const kobraX = anycubicCatalog.find(
      (product) => product.id === 'anycubic-kobra-x',
    )!
    const kobra3Lan = lanCatalog.find(
      (product) => product.id === 'anycubic-kobra-3-lan',
    )!
    for (const key of [
      'temperatures',
      'fans',
      'leds',
      'printStatus',
      'fileManager',
    ] as const) {
      expect(kobraX.controlAreas[key]).toBe('documented')
      expect(kobra3Lan.controlAreas[key]).toBe('documented')
    }
    expect(kobraX.controlAreas.webcams).toBe('unsupported')
    expect(kobra3Lan.controlAreas.webcams).toBe('documented')
    for (const key of [
      'motion',
      'extrusion',
      'macros',
      'console',
      'excludeObject',
      'jobQueue',
      'bedMesh',
      'config',
      'services',
      'history',
      'timelapse',
      'power',
      'updates',
    ] as const) {
      expect(kobraX.controlAreas[key]).toBe('unsupported')
      expect(kobra3Lan.controlAreas[key]).toBe('unsupported')
    }
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
      expect(product.controlAreas.jobQueue).toBe(
        product.id === 'snapmaker-u1' ? 'unknown' : 'simulated',
      )
      expect(product.controlAreas.extrusion).toBe('unknown')
      expect(product.controlAreas.config).toBe('unknown')
      expect(product.limitations.join(' ')).toMatch(/nunca em hardware/)
    }
  })

  it('limita a U1 às áreas com comandos comprovados no simulador', () => {
    const u1 = klipperCatalog.find((product) => product.id === 'snapmaker-u1')!
    expect(
      Object.entries(u1.controlAreas).filter(
        ([, status]) => status !== 'unknown',
      ),
    ).toEqual([
      ['temperatures', 'simulated'],
      ['motion', 'simulated'],
      ['console', 'simulated'],
      ['printStatus', 'simulated'],
    ])
  })
})
