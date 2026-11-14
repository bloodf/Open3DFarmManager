import type { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'

export function formatJobTime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
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
