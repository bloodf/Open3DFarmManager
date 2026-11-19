import type { MachineProfile } from '../../../farm-protocol/src/machine-profile.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'

/**
 * Keeps the machine block out of telemetry unless it differs from the one last
 * sent for that printer, so steady-state samples stay small.
 */
export function createMachineProfileGate() {
  const sent = new Map<string, string>()
  return {
    apply(printer: PrinterState): PrinterState {
      const { machine, ...rest } = printer
      if (!machine) return printer
      const key = JSON.stringify(machine satisfies MachineProfile)
      if (sent.get(printer.printerKey) === key) return rest
      sent.set(printer.printerKey, key)
      return printer
    },
    /** A failed enqueue must not count as sent. */
    forget(printerKey: string) {
      sent.delete(printerKey)
    },
  }
}
