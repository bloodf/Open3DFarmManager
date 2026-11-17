import { inject, type InjectionKey } from 'vue'
import type { createPrinterSetup } from './printer-setup.ts'

export type PrinterSetupActions = ReturnType<typeof createPrinterSetup> & {
  prepareSelected(): Promise<void>
  selectCrealityMoonraker(): void
}

export const printerSetupActionsKey: InjectionKey<PrinterSetupActions> = Symbol(
  'printer-setup-actions',
)

export function usePrinterSetupActions(): PrinterSetupActions {
  const actions = inject(printerSetupActionsKey)
  if (!actions) throw new Error('Printer setup actions were not provided')
  return actions
}
