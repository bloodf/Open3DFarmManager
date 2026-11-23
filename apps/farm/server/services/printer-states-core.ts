import { PrinterState } from '@open3dfarmmanager/farm-protocol'

/** One active assignment and the last state the server observed for it. */
export interface PrinterStateRow {
  assignmentId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  sortOrder?: number | null
  state: PrinterState['state']
  alarms?: PrinterState['alarms']
  progress: number | undefined
  toolTemperatureCelsius: number | undefined
  bedTemperatureCelsius: number | undefined
  observedAt: number
}

/** The public projection: no Connector identifier beyond the printer key. */
export interface PrinterStateProjection {
  assignmentId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  sortOrder?: number | null
  state: PrinterState['state']
  alarms?: PrinterState['alarms']
  progress: number | undefined
  temperatures: {
    toolCelsius: number | undefined
    bedCelsius: number | undefined
  }
  observedAt: number
}

export type PrinterStatesFailure = {
  ok: false
  reason: 'invalid-input' | 'unauthorized' | 'forbidden' | 'storage-unavailable'
}

/**
 * Projects a stored snapshot onto the published fields. Absent optional values
 * stay absent instead of becoming zero: a missing reading is not a reading of
 * zero.
 */
export function projectPrinterState(
  row: PrinterStateRow,
): PrinterStateProjection {
  const { displayName, groupName, location, sortOrder } = row
  return {
    ...(displayName !== undefined && { displayName }),
    ...(groupName !== undefined && { groupName }),
    ...(location !== undefined && { location }),
    ...(sortOrder !== undefined && { sortOrder }),
    assignmentId: row.assignmentId,
    printerKey: row.printerKey,
    state: row.state,
    ...(row.alarms !== undefined && { alarms: row.alarms }),
    progress: row.progress,
    temperatures: {
      toolCelsius: row.toolTemperatureCelsius,
      bedCelsius: row.bedTemperatureCelsius,
    },
    observedAt: row.observedAt,
  }
}

/**
 * Validates a stored snapshot before publication. The row was written by the
 * telemetry writer, but a rejected row must never reach a member as a state.
 */
export function parseStoredPrinterState(
  value: unknown,
): PrinterState | undefined {
  const parsed = PrinterState.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
