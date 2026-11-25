import { describe, expect, it } from 'vitest'
import { formatPrinterOperationalStateLabel } from '../../apps/farm/app/utils/farm-view.ts'

describe('printer fault label', () => {
  it.each(['error', 'paused'] as const)(
    'labels a %s printer fault in pt-BR',
    (state) => {
      expect(
        formatPrinterOperationalStateLabel({
          state,
          statusReason: 'printer-fault',
        }),
      ).toBe(
        `${state === 'error' ? 'Erro' : 'Pausada'} — falha informada pela impressora`,
      )
    },
  )
})
