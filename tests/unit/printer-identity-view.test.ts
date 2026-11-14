import { describe, expect, it } from 'vitest'
import { printerIdentityView } from '../../apps/farm/app/utils/printer-identity-view'

describe('printer identity view', () => {
  it('shows the observed identity and catalog support labels', () => {
    const view = printerIdentityView({
      vendor: 'Bambu Lab',
      model: 'P2S',
      firmware: '1.2',
    })
    expect(view.model).toBe('P2S')
    expect(view.firmware).toBe('1.2')
    expect(view.compatibility?.href).toBe('/compatibilidade#bambu-p2s')
    expect(view.compatibility?.statuses).toContainEqual({
      label: 'Telemetria',
      value: 'Simulado',
    })
  })
  it('keeps unknown identity and compatibility explicit', () => {
    expect(printerIdentityView(null)).toEqual({
      model: 'não identificado',
      firmware: 'não identificado',
      compatibility: null,
    })
    expect(printerIdentityView({ model: 'Unknown' }).compatibility).toBeNull()
  })
})
