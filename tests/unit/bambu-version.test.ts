import { describe, expect, it } from 'vitest'
import {
  buildGetVersionRequest,
  decodeBambuVersion,
} from '../../packages/connector/src/bambu/version'

describe('Bambu version', () => {
  it('builds a version request', () => {
    expect(buildGetVersionRequest('42')).toEqual({
      info: { command: 'get_version', sequence_id: '42' },
    })
  })
  it('decodes modules and preserves unknown product codes', () => {
    expect(
      decodeBambuVersion(
        JSON.stringify({
          info: {
            command: 'get_version',
            module: [
              {
                name: 'ota',
                product_name: 'unknown-code',
                sw_ver: '01.07.00.00',
              },
              { name: 'ams/0', sw_ver: '00.00.06.40' },
              { name: 'mc', sw_ver: '01.00.00.00' },
            ],
          },
        }),
      ),
    ).toEqual({
      model: 'unknown-code',
      firmware: '01.07.00.00',
      modules: [
        { name: 'ota', product: 'unknown-code', firmware: '01.07.00.00' },
        { name: 'ams/0', firmware: '00.00.06.40' },
        { name: 'mc', firmware: '01.00.00.00' },
      ],
    })
  })
  it('handles partial and malformed replies', () => {
    expect(
      decodeBambuVersion({
        info: {
          command: 'get_version',
          module: [null, { name: 'mc', sw_ver: 3 }],
        },
      }),
    ).toEqual({ modules: [{ name: 'mc' }] })
    expect(decodeBambuVersion('{')).toBeUndefined()
    expect(
      decodeBambuVersion({ info: { command: 'other', module: [] } }),
    ).toBeUndefined()
    expect(
      decodeBambuVersion({ info: { command: 'get_version', module: 'bad' } }),
    ).toBeUndefined()
  })
})
