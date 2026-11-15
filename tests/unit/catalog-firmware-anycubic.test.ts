import { expect, it } from 'vitest'
import { anycubicCatalog } from '../../apps/farm/app/utils/compatibility/anycubic'
import { lanCatalog } from '../../apps/farm/app/utils/compatibility/lan'

it('documenta firmware e fontes para cada modelo Anycubic', () => {
  const models = [
    ...anycubicCatalog,
    ...lanCatalog.filter((item) => item.brand === 'Anycubic'),
  ]
  expect(models.length).toBeGreaterThan(0)
  for (const model of models) {
    expect(model.firmwareNotes?.length).toBeGreaterThan(0)
    for (const note of model.firmwareNotes ?? []) {
      expect(note.firmware.length).toBeGreaterThan(0)
      expect(note.note.length).toBeGreaterThan(0)
      expect(note.sources.length).toBeGreaterThan(0)
      expect(
        note.sources.every((source) => new URL(source).protocol === 'https:'),
      ).toBe(true)
    }
  }
})
