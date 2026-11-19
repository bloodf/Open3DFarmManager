import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import { anycubicPrinterDetail } from '../anycubic/printer-detail.ts'

export function kobraXPrinterDetail(
  printer: PrinterState,
  seq: number,
  cameraId?: string,
) {
  return anycubicPrinterDetail(printer, seq, { cameraId, vendor: 'kobra-x' })
}
