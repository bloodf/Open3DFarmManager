import { formatDuration } from './ui-format.ts'
import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

export function formatJobTime(seconds: number | undefined): string | undefined {
  return formatDuration(seconds, 'hour-minute')
}

export function farmJobView(state: PrinterState) {
  return {
    filename: state.filename || undefined,
    layer:
      state.currentLayer !== undefined && state.totalLayer !== undefined
        ? `${state.currentLayer}/${state.totalLayer}`
        : undefined,
    elapsed: formatJobTime(state.printDuration),
    remaining: formatJobTime(state.estimatedRemainingSeconds),
  }
}
