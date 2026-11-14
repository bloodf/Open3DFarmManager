import type { ControlAction } from '../../../farm-protocol/src/control-actions.ts'
import type { PreparedPauseDriver } from './pause-dispatcher.ts'
import type { PrinterBinding } from './printer-binding.ts'

/** Locally registered backend support; wire claims never select a driver. */
export interface ControlDriver extends PreparedPauseDriver {
  controls(binding: PrinterBinding): readonly ControlAction[]
}
