import { describe, expect, it } from 'vitest'
import { bambuCatalog } from '../../apps/farm/app/utils/compatibility/bambu'

describe('Bambu firmware notes', () => {
  it('provides sourced firmware notes for every target model', () => {
    expect(bambuCatalog.map((product) => product.model)).toEqual([
      'A2L',
      'X2D',
      'H2C',
      'P2S',
      'H2S',
    ])
    for (const product of bambuCatalog) {
      expect(product.firmwareNotes.length).toBeGreaterThan(0)
      for (const note of product.firmwareNotes) {
        expect(note.firmware.trim()).not.toBe('')
        expect(note.note.trim()).not.toBe('')
        expect(note.sources.length).toBeGreaterThan(0)
        for (const source of note.sources) expect(source).toMatch(/^https:\/\//)
      }
    }
  })
})
