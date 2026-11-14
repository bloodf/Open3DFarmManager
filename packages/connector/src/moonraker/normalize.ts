import { PrinterState } from '@open3dfarmmanager/farm-protocol'
import type { ObservationContext, ValidatedMoonrakerSnapshot } from './parse.ts'

export function normalizeMoonrakerSnapshot(
  snapshot: ValidatedMoonrakerSnapshot,
  context: ObservationContext,
): { sourceEventtime: number; printer: PrinterState } {
  const { webhooks, print_stats, virtual_sdcard } = snapshot.status
  let state: PrinterState['state']
  if (webhooks.state === 'startup') state = 'offline'
  else if (webhooks.state !== 'ready') state = 'error'
  else {
    switch (print_stats.state) {
      case 'printing':
        state = 'printing'
        break
      case 'paused':
        state = 'paused'
        break
      case 'error':
        state = 'error'
        break
      default:
        state = 'idle'
    }
  }
  const validNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  const info =
    print_stats.info &&
    typeof print_stats.info === 'object' &&
    !Array.isArray(print_stats.info)
      ? (print_stats.info as Record<string, unknown>)
      : {}
  const filename =
    typeof print_stats.filename === 'string'
      ? print_stats.filename.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 255)
      : undefined
  const duration = print_stats.print_duration
  const remaining =
    validNumber(duration) &&
    duration > 0 &&
    virtual_sdcard.progress > 0 &&
    virtual_sdcard.progress < 1
      ? (duration * (1 - virtual_sdcard.progress)) / virtual_sdcard.progress
      : undefined
  return {
    sourceEventtime: snapshot.eventtime,
    printer: PrinterState.parse({
      ...context,
      state,
      progress: virtual_sdcard.progress,
      ...(filename ? { filename } : {}),
      ...(validNumber(duration) ? { printDuration: duration } : {}),
      ...(validNumber(print_stats.total_duration)
        ? { totalDuration: print_stats.total_duration }
        : {}),
      ...(validNumber(info.current_layer) &&
      Number.isSafeInteger(info.current_layer)
        ? { currentLayer: info.current_layer }
        : {}),
      ...(validNumber(info.total_layer) &&
      Number.isSafeInteger(info.total_layer)
        ? { totalLayer: info.total_layer }
        : {}),
      ...(remaining !== undefined && Number.isFinite(remaining)
        ? { estimatedRemainingSeconds: remaining }
        : {}),
    }),
  }
}
