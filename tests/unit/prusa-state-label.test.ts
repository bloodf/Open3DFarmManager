import { describe, expect, it } from 'vitest'
import { formatPrinterStateLabel } from '../../apps/farm/app/utils/farm-view.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'

const observed = (statusMessage?: string) =>
  PrinterState.parse({
    printerKey: 'prusa',
    state: 'unknown',
    statusReason: 'prusa-link-unqualified',
    identity: { vendor: 'Prusa', model: '1.4.0' },
    ...(statusMessage ? { statusMessage } : {}),
    observedAt: 1,
  })

describe('PrusaLink state labels', () => {
  it('names the two states that have no normalized equivalent', () => {
    expect(formatPrinterStateLabel(observed('BUSY'))).toBe('Impressora ocupada')
    expect(formatPrinterStateLabel(observed('ATTENTION'))).toBe(
      'A impressora pede atenção na tela',
    )
  })

  it('never shows an unrecognised wire word', () => {
    for (const word of [undefined, 'NEW_STATE', 'constructor'])
      expect(formatPrinterStateLabel(observed(word))).toBe(
        'Estado da impressora desconhecido',
      )
  })
})
