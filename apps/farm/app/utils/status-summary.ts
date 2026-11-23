import { z } from 'zod'
import { PrinterState } from '../../../../packages/farm-protocol/src/state.ts'
import type { LastKnownState } from '../composables/useLastKnownStates-core.ts'

/** Mirrors STATUS_SUMMARY_MAX_PRINTERS of the server route. */
const MAX_PRINTERS = 500
const PRINTER_STATES = [
  'idle',
  'printing',
  'paused',
  'error',
  'offline',
] as const

const SummaryPrinter = z.object({
  assignmentId: z.string().min(1).max(128),
  printerKey: z.string().min(1).max(128),
  displayName: z.string().nullable().optional(),
  groupName: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  state: z.enum(PRINTER_STATES),
  alarms: PrinterState.shape.alarms,
  progress: z.number().min(0).max(1).optional(),
  temperatures: z
    .object({
      toolCelsius: z.number().finite().optional(),
      bedCelsius: z.number().finite().optional(),
    })
    .default({}),
  observedAt: z.number().int().nonnegative(),
})

const SummaryResponse = z.object({
  generatedAt: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean(),
  printers: z.array(SummaryPrinter).max(MAX_PRINTERS),
})

export type StatusSummaryState = (typeof PRINTER_STATES)[number]

/** The summary the wall and the TV panel read, in the shape both render. */
export type StatusSummaryView = {
  generatedAt: number
  total: number
  truncated: boolean
  /** Printers per state; every known state is present, absent ones are 0. */
  counts: Record<StatusSummaryState, number>
  states: LastKnownState[]
}

export type StatusSummaryParse =
  | { ok: true; summary: StatusSummaryView }
  | { ok: false; reason: 'unavailable' }

/**
 * Parses the `status-summary` answer. A malformed answer is a failure, not a
 * partial wall: a repeated assignment would render two cards for one printer.
 */
export function parseStatusSummary(value: unknown): StatusSummaryParse {
  const parsed = SummaryResponse.safeParse(value)
  if (!parsed.success) return { ok: false, reason: 'unavailable' }
  const { printers, counts, generatedAt, total, truncated } = parsed.data
  const seen = new Set<string>()
  for (const printer of printers) {
    if (seen.has(printer.assignmentId))
      return { ok: false, reason: 'unavailable' }
    seen.add(printer.assignmentId)
  }
  const known = Object.fromEntries(
    PRINTER_STATES.map((state) => [state, counts[state] ?? 0]),
  ) as Record<StatusSummaryState, number>
  const states = printers.map((printer) => ({
    assignmentId: printer.assignmentId,
    printerKey: printer.printerKey,
    ...(printer.displayName !== undefined
      ? { displayName: printer.displayName }
      : {}),
    ...(printer.groupName !== undefined
      ? { groupName: printer.groupName }
      : {}),
    ...(printer.location !== undefined ? { location: printer.location } : {}),
    state: printer.state,
    ...(printer.alarms !== undefined && { alarms: printer.alarms }),
    progress: printer.progress,
    // A missing reading is not a reading of zero.
    temperatures: {
      toolCelsius: printer.temperatures.toolCelsius,
      bedCelsius: printer.temperatures.bedCelsius,
    },
    observedAt: printer.observedAt,
  }))
  return {
    ok: true,
    summary: { generatedAt, total, truncated, counts: known, states },
  }
}

/** The route is the same for the wall and the panel. */
export function statusSummaryPath(farmId: string): string {
  return `/api/farms/${encodeURIComponent(farmId)}/status-summary`
}
