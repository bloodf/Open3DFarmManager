import { describe, expect, it } from 'vitest'
import { compatibilityPageCatalog } from '../../apps/farm/app/utils/compatibility'

describe('catálogo de integrações simuladas', () => {
  it.each([
    [
      'anycubic-kobra-3-lan',
      ['telemetry', 'files', 'pause', 'resume', 'cancel'],
    ],
    [
      'creality-k1-stock-lan',
      ['telemetry', 'files', 'pause', 'resume', 'cancel'],
    ],
    // Telemetry on the Kobra X is hardware-proven; the rest stay simulated.
    ['anycubic-kobra-x', ['files', 'pause', 'resume', 'cancel']],
  ] as const)('%s informa os recursos e limites', (id, capabilities) => {
    const product = compatibilityPageCatalog.find((item) => item.id === id)
    expect(product).toBeDefined()
    for (const capability of capabilities)
      expect(product?.capabilities[capability]).toBe('simulated')
    expect(product?.limitations.join(' ')).toContain(
      'não comprovado em hardware',
    )
  })

  it('distingue operações de arquivo e macros disponíveis', () => {
    const find = (id: string) =>
      compatibilityPageCatalog
        .find((item) => item.id === id)!
        .limitations.join(' ')
    expect(find('anycubic-kobra-3-lan')).toContain(
      'envio e listagem não são suportados',
    )
    expect(find('creality-k1-stock-lan')).toContain('listagem não é suportada')
    expect(find('klipper-generic-moonraker')).toContain(
      'dependem das macros configuradas',
    )
  })
})
