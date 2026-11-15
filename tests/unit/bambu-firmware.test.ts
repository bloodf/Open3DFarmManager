import { describe, expect, it } from 'vitest'
import { mapBambuFirmware } from '../../packages/connector/src/bambu/firmware'

describe('Bambu firmware', () => {
  it('maps observed modules and OTA versions', () => {
    expect(
      mapBambuFirmware(
        {
          info: {
            command: 'get_version',
            module: [
              { name: 'ota', sw_ver: '01.00.00.00' },
              { name: 'ams/0', sw_ver: '00.01.00.00' },
            ],
          },
        },
        {
          print: {
            upgrade_state: {
              new_ver_list: [
                { module: 'ota', version: '01.01.00.00' },
                { module: 'ams/0', version: '00.02.00.00' },
              ],
            },
          },
        },
      ),
    ).toEqual({
      current: '01.00.00.00',
      latest: '01.01.00.00',
      updateAvailable: true,
      components: [
        { name: 'ota', current: '01.00.00.00', latest: '01.01.00.00' },
        { name: 'ams/0', current: '00.01.00.00', latest: '00.02.00.00' },
      ],
    })
  })
  it('omits invalid and absent values and bounds components', () => {
    expect(mapBambuFirmware(null, {})).toBeUndefined()
    expect(
      mapBambuFirmware({
        info: {
          command: 'get_version',
          module: Array.from({ length: 20 }, (_, i) => ({
            name: `m${i}`,
            sw_ver: '1',
          })),
        },
      })?.components,
    ).toHaveLength(16)
    expect(
      mapBambuFirmware({
        info: {
          command: 'get_version',
          module: [{ name: 'ota', sw_ver: 'x'.repeat(65) }],
        },
      }),
    ).toBeUndefined()
  })
})
