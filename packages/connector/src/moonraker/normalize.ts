import {
  boundPrinterString,
  PrinterState,
} from '@open3dfarmmanager/farm-protocol'
import { observedTemperatureDetails } from './temperature-observation.ts'
import type { ObservationContext, ValidatedMoonrakerSnapshot } from './parse.ts'

function parseFanSpeedPercent(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined
  const speed = (raw as Record<string, unknown>).speed
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return undefined
  const clamped = Math.max(0, Math.min(1, speed))
  return Math.round(clamped * 100)
}

function parsePinValue(raw: unknown): boolean | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined
  const value = (raw as Record<string, unknown>).value
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value > 0
}

const OUTCOMES = {
  complete: 'completed',
  cancelled: 'cancelled',
  error: 'failed',
} as const

/**
 * Finished-job summary from a ready printer's terminal print_stats state.
 * Kept apart from the per-snapshot projection: Moonraker keeps reporting the
 * terminal state until the next print, so only a stateful caller can say when
 * the job ended.
 */
export function moonrakerLastJob(
  status: Readonly<{
    webhooks: { state: string }
    print_stats: Readonly<Record<string, unknown>>
  }>,
  observedAt: number,
): PrinterState['lastJob'] {
  const stats = status.print_stats
  const outcome =
    status.webhooks.state === 'ready' &&
    typeof stats.state === 'string' &&
    Object.hasOwn(OUTCOMES, stats.state)
      ? OUTCOMES[stats.state as keyof typeof OUTCOMES]
      : undefined
  if (outcome === undefined) return undefined
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  const filename =
    typeof stats.filename === 'string'
      ? boundPrinterString(
          stats.filename.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''),
        )
      : ''
  return {
    outcome,
    ...(filename ? { filename } : {}),
    ...(valid(stats.print_duration)
      ? { printDuration: stats.print_duration }
      : {}),
    ...(valid(stats.total_duration)
      ? { totalDuration: stats.total_duration }
      : {}),
    ...(valid(stats.filament_used)
      ? { filamentUsedMillimetres: stats.filament_used }
      : {}),
    endedAt: observedAt,
  }
}

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
      ? boundPrinterString(
          print_stats.filename.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''),
        )
      : undefined
  const duration = print_stats.print_duration
  const remaining =
    validNumber(duration) &&
    duration > 0 &&
    virtual_sdcard.progress > 0 &&
    virtual_sdcard.progress < 1
      ? (duration * (1 - virtual_sdcard.progress)) / virtual_sdcard.progress
      : undefined

  const rawStatus = snapshot.status as Record<string, unknown>

  // Fans extraction: fan (part), fan_generic aux / aux_fan, fan_generic chamber / chamber_fan
  let partFan: number | undefined
  if ('fan' in rawStatus) {
    partFan = parseFanSpeedPercent(rawStatus.fan)
  } else if ('fan_generic part' in rawStatus) {
    partFan = parseFanSpeedPercent(rawStatus['fan_generic part'])
  } else if ('fan_generic part_fan' in rawStatus) {
    partFan = parseFanSpeedPercent(rawStatus['fan_generic part_fan'])
  }

  let auxFan: number | undefined
  if ('fan_generic aux' in rawStatus) {
    auxFan = parseFanSpeedPercent(rawStatus['fan_generic aux'])
  } else if ('fan_generic aux_fan' in rawStatus) {
    auxFan = parseFanSpeedPercent(rawStatus['fan_generic aux_fan'])
  }

  let chamberFan: number | undefined
  if ('fan_generic chamber' in rawStatus) {
    chamberFan = parseFanSpeedPercent(rawStatus['fan_generic chamber'])
  } else if ('fan_generic chamber_fan' in rawStatus) {
    chamberFan = parseFanSpeedPercent(rawStatus['fan_generic chamber_fan'])
  }

  const fans: PrinterState['fans'] =
    partFan !== undefined || auxFan !== undefined || chamberFan !== undefined
      ? {
          ...(partFan !== undefined ? { part: partFan } : {}),
          ...(auxFan !== undefined ? { aux: auxFan } : {}),
          ...(chamberFan !== undefined ? { chamber: chamberFan } : {}),
        }
      : undefined

  // Light extraction: output_pin caselight
  let chamberLight: boolean | undefined
  if ('output_pin caselight' in rawStatus) {
    chamberLight = parsePinValue(rawStatus['output_pin caselight'])
  }

  const light: PrinterState['light'] =
    chamberLight !== undefined ? { chamber: chamberLight } : undefined

  return {
    sourceEventtime: snapshot.eventtime,
    printer: PrinterState.parse({
      ...context,
      state,
      progress: virtual_sdcard.progress,
      ...observedTemperatureDetails(rawStatus),
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
      ...(fans !== undefined ? { fans } : {}),
      ...(light !== undefined ? { light } : {}),
    }),
  }
}
