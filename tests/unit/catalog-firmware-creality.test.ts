import { describe, expect, it } from 'vitest'
import { crealityCatalog } from '../../apps/farm/app/utils/compatibility/creality'

describe('notas de firmware Creality', () => {
  it('inclui notas e fontes para cada modelo', () => {
    expect(crealityCatalog).toHaveLength(5)
    for (const product of crealityCatalog) {
      expect(product.firmwareNotes.length).toBeGreaterThan(0)
      for (const note of product.firmwareNotes) {
        expect(note.firmware.trim()).not.toBe('')
        expect(note.note.trim()).not.toBe('')
        expect(note.sources.length).toBeGreaterThan(0)
        expect(
          note.sources.every((source) => source.startsWith('https://')),
        ).toBe(true)
      }
    }
  })
})
