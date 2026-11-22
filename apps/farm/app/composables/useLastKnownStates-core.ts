import { z } from 'zod'

/**
 * The published projection of `/api/farms/[farmId]/printer-states`. The route
 * answers the last state the server observed for each active assignment: the
 * state, the progress, the temperatures and the instant the Connector observed
 * it. Absent optional values stay absent instead of becoming zero.
 */
export const LastKnownPrinterState = z.strictObject({
  assignmentId: z.string().min(1).max(128),
  printerKey: z.string().min(1).max(128),
  displayName: z.string().nullable().optional(),
  groupName: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  sortOrder: z.number().int().nullable().optional(),
  state: z.enum(['idle', 'printing', 'paused', 'error', 'offline']),
  progress: z.number().min(0).max(1).optional(),
  temperatures: z.strictObject({
    toolCelsius: z.number().finite().optional(),
    bedCelsius: z.number().finite().optional(),
  }),
  observedAt: z.number().int().nonnegative(),
})
export type LastKnownPrinterState = z.infer<typeof LastKnownPrinterState>

export const LastKnownPrinterStatesResponse = z.strictObject({
  states: z.array(LastKnownPrinterState).max(200),
})
export type LastKnownPrinterStatesResponse = z.infer<
  typeof LastKnownPrinterStatesResponse
>

/** A stored state paired with the age derived from its `observedAt`. */
export type LastKnownState = {
  assignmentId: string
  printerKey: string
  displayName?: string | null
  groupName?: string | null
  location?: string | null
  sortOrder?: number | null
  state: LastKnownPrinterState['state']
  progress: number | undefined
  temperatures: {
    toolCelsius: number | undefined
    bedCelsius: number | undefined
  }
  observedAt: number
}

export type LastKnownStatesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; states: readonly LastKnownState[] }
  | { kind: 'unavailable'; reason: LastKnownStatesFailure['reason'] }

export type LastKnownStatesFailure = {
  ok: false
  reason: 'unauthorized' | 'forbidden' | 'unavailable'
}

/** The label every offline card carries. */
export const OFFLINE_CONNECTION_LABEL = 'sem conexão direta'

/**
 * The age of a stored state, in whole seconds, measured from `observedAt`.
 *
 * The Connector's clock is not the browser's clock, so a future observation
 * cannot be trusted as a negative age: it is reported as unknown instead of a
 * number the operator would read as "just updated".
 */
export function lastKnownStateAgeSeconds(
  observedAt: number,
  nowWallMs: number,
): number | null {
  if (!Number.isFinite(observedAt) || !Number.isFinite(nowWallMs)) return null
  const elapsed = nowWallMs - observedAt
  if (elapsed < 0) return null
  return Math.floor(elapsed / 1000)
}

/**
 * Human readable age of a stored state, in pt-BR.
 *
 * One clock reading drives the whole label: the age never mixes readings, so a
 * card cannot report two different ages for the same observation.
 */
export function lastKnownStateAgeLabel(
  observedAt: number,
  nowWallMs: number,
): string {
  const seconds = lastKnownStateAgeSeconds(observedAt, nowWallMs)
  if (seconds === null) return 'Idade da observação não confirmada'
  if (seconds >= 86_400)
    return 'Observação com mais de 24 h. Estado possivelmente desatualizado.'
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return minutes
      ? `Observação com ${hours} h e ${minutes} min`
      : `Observação com ${hours} h`
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    return `Observação com ${minutes} min`
  }
  return `Observação com ${seconds} s`
}

/**
 * Parses the route response. A malformed answer is a failure, not a state:
 * nothing partial reaches the operator as a printer card.
 */
export function parseLastKnownStates(
  value: unknown,
): { ok: true; states: LastKnownState[] } | LastKnownStatesFailure {
  const parsed = LastKnownPrinterStatesResponse.safeParse(value)
  if (!parsed.success) return { ok: false, reason: 'unavailable' }
  const states = parsed.data.states.map((state) => ({
    assignmentId: state.assignmentId,
    printerKey: state.printerKey,
    ...(state.displayName !== undefined
      ? { displayName: state.displayName }
      : {}),
    ...(state.groupName !== undefined ? { groupName: state.groupName } : {}),
    ...(state.location !== undefined ? { location: state.location } : {}),
    ...(state.sortOrder !== undefined ? { sortOrder: state.sortOrder } : {}),
    state: state.state,
    progress: state.progress,
    // A missing reading is not a reading of zero: the key stays present and
    // the value stays undefined.
    temperatures: {
      toolCelsius: state.temperatures.toolCelsius,
      bedCelsius: state.temperatures.bedCelsius,
    },
    observedAt: state.observedAt,
  }))
  // A repeated assignment would render two cards for one printer.
  const seen = new Set<string>()
  for (const state of states) {
    if (seen.has(state.assignmentId))
      return { ok: false, reason: 'unavailable' }
    seen.add(state.assignmentId)
  }
  return { ok: true, states }
}

/**
 * The failure reason for a rejected read of the stored states.
 *
 * The route answers 401 for a missing session, 404 for a farm the account
 * cannot see and 503 when the storage is unavailable. A 404 also covers the
 * runtime being off, which is not the member's fault.
 */
export function lastKnownStatesFailureReason(status: number | undefined) {
  if (status === 401) return 'unauthorized' as const
  if (status === 403 || status === 404) return 'forbidden' as const
  return 'unavailable' as const
}

/**
 * The assignments the live feed already owns.
 *
 * A live row with no observation yet is still a live row: the feed owns that
 * printer and its stored state must not be shown next to it.
 */
export function liveAssignmentIds<
  Live extends { assignment: { assignmentId: string }; connection?: string },
>(liveRows: readonly Live[]): ReadonlySet<string> {
  return new Set(
    liveRows
      .filter((row) => row.connection === 'authenticated')
      .map((row) => row.assignment.assignmentId),
  )
}

/**
 * The offline cards the page renders.
 *
 * The live rows are authoritative: a printer the feed reports keeps its live
 * card and never gains a second card from the stored snapshot. Only the
 * printers the feed does not own keep their stored state, so one printer is
 * always one card.
 */
export function offlineCards<
  Live extends { assignment: { assignmentId: string }; connection?: string },
>(
  liveRows: readonly Live[],
  storedStates: readonly LastKnownState[],
): LastKnownState[] {
  const live = liveAssignmentIds(liveRows)
  return storedStates.filter((state) => !live.has(state.assignmentId))
}
