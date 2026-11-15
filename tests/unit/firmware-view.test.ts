import { describe, expect, it } from 'vitest'
import { firmwareView } from '../../apps/farm/app/utils/farm-firmware-view'

describe('firmware view', () => {
  it('shows reported versions and update availability', () => {
    expect(
      firmwareView({
        current: '1.0',
        latest: '2.0',
        updateAvailable: true,
        components: [{ name: 'MCU', current: '1', latest: '2' }],
      }),
    ).toEqual({
      current: '1.0',
      latest: '2.0',
      updateAvailable: true,
      components: [{ name: 'MCU', current: '1', latest: '2' }],
    })
  })
  it('does not infer an update and falls back to identity', () => {
    expect(firmwareView({ latest: '2.0' }, '1.0')).toEqual({
      current: '1.0',
      latest: '2.0',
      updateAvailable: false,
      components: [],
    })
    expect(firmwareView().current).toBe('não identificado')
  })
})
