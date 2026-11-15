import { expect, it } from 'vitest'
import { klipperCatalog } from '../../apps/farm/app/utils/compatibility/klipper'

it('documenta firmware e fonte para cada modelo Klipper', () => {
  for (const product of klipperCatalog) {
    expect(product.firmwareNotes?.length).toBeGreaterThan(0)
    for (const entry of product.firmwareNotes ?? []) {
      expect(entry.firmware.trim()).not.toBe('')
      expect(entry.note).toMatch(/https:\/\/\S+/)
    }
  }
})
