import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkCompatibility as webCheck } from '../../apps/farm/app/utils/checkCompatibility.ts'
import { checkCompatibility as connectorCheck } from '../../packages/connector/src/files/compatibility.ts'
import {
  checkCompatibility,
  type CompatibilityMetadata,
  type CompatibilityProfile,
  type LoadedMaterial,
} from '../../packages/shared/src/print-file/compatibility.ts'
import {
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/network-guard.ts'

const tool = {
  nozzleDiameter: 0.4,
  filamentType: 'PLA',
  filamentColour: '#aabbcc',
}
const metadata: CompatibilityMetadata = {
  format: 'gcode',
  printerModel: 'Modelo A',
  tools: [tool],
  boundingBox: { x: 200, y: 200, z: 150 },
}
const profile: CompatibilityProfile = {
  model: 'Modelo A',
  compatibleModels: ['Modelo B'],
  nozzleDiameters: [0.4],
  bedSize: { x: 200, y: 200, z: 150 },
}
const materials: LoadedMaterial[] = [{ type: 'pla', colour: '#AABBCC' }]

type MetadataOverride = {
  [K in keyof CompatibilityMetadata]?: CompatibilityMetadata[K] | undefined
}
type Row = [
  name: string,
  meta: MetadataOverride,
  printer: Partial<CompatibilityProfile>,
  level: 'ok' | 'warn' | 'block',
  reasons: string[],
]

/** An explicit `undefined` override removes the key from the base metadata. */
function withMetadata(overrides: MetadataOverride): CompatibilityMetadata {
  const result: CompatibilityMetadata = { ...metadata }
  for (const key of Object.keys(overrides) as (keyof MetadataOverride)[]) {
    if (overrides[key] === undefined) delete result[key]
    else Object.assign(result, { [key]: overrides[key] })
  }
  return result
}

describe('checkCompatibility', () => {
  beforeEach(installNetworkGuard)
  afterEach(uninstallNetworkGuard)

  it('exposes the same function in the web app and Connector', () => {
    expect(webCheck).toBe(checkCompatibility)
    expect(connectorCheck).toBe(checkCompatibility)
  })

  it.each<Row>([
    ['matching printer and exact bed fit', {}, {}, 'ok', []],
    ['listed model', { printerModel: 'Modelo B' }, {}, 'ok', []],
    ['unlisted model', { printerModel: 'Modelo C' }, {}, 'block', ['block']],
    [
      'different nozzle',
      { tools: [{ ...tool, nozzleDiameter: 0.6 }] },
      {},
      'block',
      ['block'],
    ],
    ['too few tools', { tools: [tool, tool] }, {}, 'block', ['block']],
    ['bed too narrow', {}, { bedSize: { x: 199, y: 200 } }, 'block', ['block']],
    [
      'bed too shallow',
      {},
      { bedSize: { x: 200, y: 199 } },
      'block',
      ['block'],
    ],
    [
      'height too low',
      {},
      { bedSize: { x: 200, y: 200, z: 149 } },
      'block',
      ['block'],
    ],
    ['unknown height', {}, { bedSize: { x: 200, y: 200 } }, 'ok', []],
    ['unknown bounds', { boundingBox: undefined }, {}, 'ok', []],
    ['unsliced 3MF', { format: '3mf', sliced: false }, {}, 'block', ['block']],
    ['sliced 3MF', { format: '3mf', sliced: true }, {}, 'ok', []],
    ['unknown 3MF slicing state', { format: '3mf' }, {}, 'warn', ['warn']],
    ['missing model', { printerModel: undefined }, {}, 'warn', ['warn']],
    ['missing tools', { tools: undefined }, {}, 'warn', ['warn']],
    ['empty tools', { tools: [] }, {}, 'warn', ['warn']],
    [
      'missing nozzle and material type',
      { tools: [{}] },
      {},
      'warn',
      ['warn', 'warn'],
    ],
    [
      'different material',
      { tools: [{ ...tool, filamentType: 'PETG' }] },
      {},
      'warn',
      ['warn'],
    ],
    [
      'different colour',
      { tools: [{ ...tool, filamentColour: '#ffffff' }] },
      {},
      'ok',
      ['info'],
    ],
    [
      'block takes precedence and preserves other reasons',
      {
        printerModel: 'Modelo C',
        tools: [{ ...tool, filamentType: 'PETG', filamentColour: '#ffffff' }],
      },
      {},
      'block',
      ['block', 'warn', 'info'],
    ],
  ])('%s', (_name, meta, printer, level, reasons) => {
    const result = checkCompatibility(
      withMetadata(meta),
      { ...profile, ...printer },
      materials,
    )
    expect(result.level).toBe(level)
    expect(result.reasons.map((reason) => reason.level)).toEqual(reasons)
    for (const reason of result.reasons)
      expect(reason.message.trim()).not.toBe('')
  })
})
