import { describe, expect, it } from 'vitest'
import {
  discoveryLabel,
  discoveryPrefill,
  discoveryStatus,
} from '../../apps/farm/app/utils/printer-discovery-view.ts'

describe('printer discovery view', () => {
  it('prefills Bambu and Moonraker without credentials', () => {
    expect(
      discoveryPrefill({
        vendor: 'bambu',
        host: '192.168.1.2',
        serial: 'ABC',
        name: 'Mesa',
      }),
    ).toEqual({
      family: 'bambu-lan',
      ip: '192.168.1.2',
      serial: 'ABC',
      label: 'Mesa',
    })
    expect(
      discoveryPrefill({
        vendor: 'moonraker',
        host: '192.168.1.3',
        port: 7125,
      }),
    ).toEqual({
      family: 'klipper-moonraker',
      origin: 'http://192.168.1.3:7125',
      label: '',
    })
  })
  it('labels and prefills all four discovery protocols', () => {
    expect(discoveryLabel({ vendor: 'bambu', host: '192.168.1.2' })).toBe(
      'Bambu Lab',
    )
    expect(discoveryLabel({ vendor: 'moonraker', host: '192.168.1.3' })).toBe(
      'Moonraker',
    )
    expect(discoveryLabel({ vendor: 'creality', host: '192.168.1.4' })).toBe(
      'Creality',
    )
    expect(discoveryLabel({ vendor: 'anycubic', host: '192.168.1.5' })).toBe(
      'Anycubic',
    )
    expect(
      discoveryPrefill({
        vendor: 'creality',
        host: '192.168.1.4',
        name: 'K1',
      }),
    ).toEqual({
      family: 'creality-native',
      host: '192.168.1.4',
      label: 'K1',
    })
    expect(
      discoveryPrefill({
        vendor: 'anycubic',
        host: '192.168.1.5',
      }),
    ).toEqual({
      family: 'anycubic-lan',
      host: '192.168.1.5',
      label: '',
    })
  })
  it('describes empty and failed searches', () => {
    expect(discoveryStatus({ request_id: 'id', ok: true, printers: [] })).toBe(
      'Nenhuma impressora encontrada.',
    )
    expect(
      discoveryStatus({ request_id: 'id', ok: false, reason: 'busy' }),
    ).toContain('Não foi possível')
  })
})
