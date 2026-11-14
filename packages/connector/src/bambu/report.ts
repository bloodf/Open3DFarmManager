import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

/** Maximum payload size in bytes for a Bambu MQTT report frame (128 KiB). */
export const MAX_BAMBU_FRAME_BYTES = 128 * 1024

export type BambuReportResult =
  | {
      kind: 'observation'
      state?: PrinterState['state']
      progress?: number
      toolTemperatureCelsius?: number
      bedTemperatureCelsius?: number
    }
  | { kind: 'ignored' }
  | { kind: 'invalid'; reason: string }

/**
 * Maps documented Bambu Lab gcode_state values to internal PrinterState['state'].
 *
 * Recognized primary vendor states:
 * - IDLE, FINISH -> 'idle'
 * - PREPARE, RUNNING -> 'printing'
 * - PAUSE -> 'paused'
 * - FAILED -> 'error'
 * - OFFLINE -> 'offline'
 *
 * Note: Missing, null, empty or unknown values return undefined so that
 * unknown/transient states never silently map to idle, zero, or offline.
 */
export function mapBambuGcodeState(
  rawState: unknown,
): PrinterState['state'] | undefined {
  if (typeof rawState !== 'string') return undefined
  const normalized = rawState.trim().toUpperCase()
  switch (normalized) {
    case 'IDLE':
    case 'FINISH':
      return 'idle'
    case 'PREPARE':
    case 'RUNNING':
      return 'printing'
    case 'PAUSE':
      return 'paused'
    case 'FAILED':
      return 'error'
    case 'OFFLINE':
      return 'offline'
    default:
      // Other values (e.g. "INIT", "SLICING", "UNKNOWN", or unrecognized)
      // must never become idle/zero/offline.
      return undefined
  }
}

/**
 * Normalizes Bambu Lab progress percentage (mc_percent: 0-100) into 0-1 range.
 * Returns undefined if missing, null, or out of valid bounds.
 */
export function normalizeBambuProgress(
  rawPercent: unknown,
): number | undefined {
  let num: number
  if (typeof rawPercent === 'number') {
    num = rawPercent
  } else if (typeof rawPercent === 'string' && rawPercent.trim() !== '') {
    num = Number(rawPercent)
  } else {
    return undefined
  }

  if (!Number.isFinite(num) || num < 0 || num > 100) {
    return undefined
  }

  return num / 100
}

/**
 * Extracts and validates a temperature in Celsius.
 * Must be a finite number.
 */
export function parseBambuTemperature(rawTemp: unknown): number | undefined {
  let num: number
  if (typeof rawTemp === 'number') {
    num = rawTemp
  } else if (typeof rawTemp === 'string' && rawTemp.trim() !== '') {
    num = Number(rawTemp)
  } else {
    return undefined
  }

  if (!Number.isFinite(num)) {
    return undefined
  }

  return num
}

/**
 * Bounded decoder for Bambu Lab MQTT report frames.
 *
 * Accepts either a JSON wire string or an already parsed JS object.
 * Returns a discriminated result:
 * - 'observation': valid report containing printer telemetry fields
 * - 'ignored': non-telemetry command report or non-print message
 * - 'invalid': malformed JSON, oversized frame, or invalid top-level shape
 */
export function decodeBambuReport(input: unknown): BambuReportResult {
  let parsed: unknown

  if (typeof input === 'string') {
    // Check wire byte length before decoding
    const byteLength = Buffer.byteLength(input, 'utf8')
    if (byteLength > MAX_BAMBU_FRAME_BYTES) {
      return { kind: 'invalid', reason: 'frame_too_large' }
    }

    try {
      parsed = parseBoundedJson(input, {
        maxBytes: MAX_BAMBU_FRAME_BYTES,
        maxDepth: 16,
        maxValues: 8192,
        maxStringChars: 16384,
      })
    } catch (error) {
      return {
        kind: 'invalid',
        reason: error instanceof Error ? error.message : 'invalid_json',
      }
    }
  } else if (input && typeof input === 'object') {
    parsed = input
  } else {
    return { kind: 'invalid', reason: 'invalid_input_type' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'not_an_object' }
  }

  const record = parsed as Record<string, unknown>

  // Bambu Lab reports are keyed by subsystem: "print", "info", "upgrade", "pushing", etc.
  if (!('print' in record)) {
    // Non-print message (e.g. info.get_version, upgrade reports, etc.) -> ignored
    return { kind: 'ignored' }
  }

  const print = record.print
  if (!print || typeof print !== 'object' || Array.isArray(print)) {
    return { kind: 'invalid', reason: 'invalid_print_payload' }
  }

  const printRecord = print as Record<string, unknown>

  // Check command if present: "push_status", "pushall", or command responses
  // If command is present and not a telemetry status push, determine if it should be ignored or processed.
  // In push status or delta updates, command is usually "push_status" or absent.
  // If it's an explicit response to another command like "ams_get_rfid", check if it contains status fields.
  const command =
    typeof printRecord.command === 'string'
      ? printRecord.command.toLowerCase()
      : undefined
  if (
    command !== undefined &&
    command !== 'push_status' &&
    command !== 'pushall'
  ) {
    // Check if it has any telemetry fields before ignoring
    const hasTelemetryFields =
      'gcode_state' in printRecord ||
      'mc_percent' in printRecord ||
      'nozzle_temper' in printRecord ||
      'bed_temper' in printRecord

    if (!hasTelemetryFields) {
      return { kind: 'ignored' }
    }
  }

  // Extract observed fields
  let state: PrinterState['state'] | undefined
  if ('gcode_state' in printRecord && printRecord.gcode_state !== null) {
    state = mapBambuGcodeState(printRecord.gcode_state)
  }

  let progress: number | undefined
  if ('mc_percent' in printRecord && printRecord.mc_percent !== null) {
    progress = normalizeBambuProgress(printRecord.mc_percent)
  }

  let toolTemperatureCelsius: number | undefined
  if ('nozzle_temper' in printRecord && printRecord.nozzle_temper !== null) {
    toolTemperatureCelsius = parseBambuTemperature(printRecord.nozzle_temper)
  }

  let bedTemperatureCelsius: number | undefined
  if ('bed_temper' in printRecord && printRecord.bed_temper !== null) {
    bedTemperatureCelsius = parseBambuTemperature(printRecord.bed_temper)
  }

  const observation: Extract<BambuReportResult, { kind: 'observation' }> = {
    kind: 'observation',
  }

  if (state !== undefined) {
    observation.state = state
  }
  if (progress !== undefined) {
    observation.progress = progress
  }
  if (toolTemperatureCelsius !== undefined) {
    observation.toolTemperatureCelsius = toolTemperatureCelsius
  }
  if (bedTemperatureCelsius !== undefined) {
    observation.bedTemperatureCelsius = bedTemperatureCelsius
  }

  return observation
}
