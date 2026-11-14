import { describe, expect, it } from 'vitest'
import {
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
  it('describes empty and failed searches', () => {
    expect(discoveryStatus({ request_id: 'id', ok: true, printers: [] })).toBe(
      'Nenhuma impressora encontrada.',
    )
    expect(
      discoveryStatus({ request_id: 'id', ok: false, reason: 'busy' }),
    ).toContain('Não foi possível')
  })
})
