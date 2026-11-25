import { expect, it } from 'vitest'
import {
  effectiveSlotColour,
  suggestMapping,
  type ReplayPrinter,
  type ReplaySource,
} from '../../apps/farm/app/utils/replay-view'

it('uses the active Spoolman colour for replay mapping and compatibility', () => {
  const source: ReplaySource = {
    sha256: 'a'.repeat(64),
    name: 'test',
    kind: '3mf',
    plateCount: 1,
    storageLocation: 'server',
    agentId: null,
    metadata: { tools: [{ filamentType: 'PLA', filamentColour: '#ff0000' }] },
  }
  const printer: ReplayPrinter = {
    key: 'p',
    label: 'p',
    agentId: 'a',
    model: '',
    nozzleDiameters: [],
    connectorOnline: true,
    live: true,
    materials: [
      {
        slot: '0',
        materialType: 'PLA',
        colorHex: 'FF0000FF',
        spoolmanColorHex: '0000ff',
      },
      {
        slot: '1',
        materialType: 'PLA',
        colorHex: '0000FFFF',
        spoolmanColorHex: 'ff0000',
      },
    ],
  }
  expect(effectiveSlotColour(printer.materials[0]!)).toBe('0000ff')
  expect(suggestMapping(source, printer)).toEqual([1])
})
