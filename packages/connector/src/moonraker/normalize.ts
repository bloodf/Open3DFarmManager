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
  return {
    sourceEventtime: snapshot.eventtime,
    printer: PrinterState.parse({
      ...context,
      state,
      progress: virtual_sdcard.progress,
    }),
  }
}
