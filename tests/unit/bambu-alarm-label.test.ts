import { expect, it } from 'vitest'
import { formatPrinterStateLabel } from '../../apps/farm/app/utils/farm-view.ts'

it('shows the print error and HMS summary alongside the printing state', () => {
  expect(
    formatPrinterStateLabel({
      state: 'printing',
      alarms: {
        printError: '0300-8005',
        hmsCount: 1,
        hmsCode: '0500-0200-0002-0001',
      },
    }),
  ).toBe(
    'Imprimindo — Erro de impressão: 0300-8005 — Alertas HMS: 1 (0500-0200-0002-0001)',
  )
  expect(
    formatPrinterStateLabel({
      state: 'printing',
      alarms: { printError: null, hmsCount: 1, hmsCode: '0500-0200-0002-0001' },
    }),
  ).toBe('Imprimindo — Alertas HMS: 1 (0500-0200-0002-0001)')
  expect(
    formatPrinterStateLabel({
      state: 'printing',
      alarms: { printError: null, hmsCount: 0, hmsCode: null },
    }),
  ).toBe('Imprimindo')
})
