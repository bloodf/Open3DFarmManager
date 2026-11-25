// Live side of replay: what the signed session knows about each printer and
// signed `start_library_print` sessions used by replay.
import type { LibraryPrintArgs } from '../../../../packages/farm-protocol/src/control-actions.ts'
import { controlObservationState } from '../../../../packages/farm-protocol/src/control-actions.ts'
import {
  clockNotBefore,
  controlActionAvailability,
  type Clock,
} from './farm-control.ts'
import { observationAge, type FarmKeyState, type FarmRow } from './farm-view.ts'
import type { ReplayPrinter, ReplayResult } from './replay-view.ts'
import type { FarmPauseControlState } from './webrtc/farm-pause-control.ts'
import type { ActiveSpool } from '../../../../packages/farm-protocol/src/status.ts'

/** The part of a printer the live session decides. */
export type LiveReplayInfo = Pick<
  ReplayPrinter,
  'connectorOnline' | 'live' | 'materials'
> &
  Partial<Pick<ReplayPrinter, 'state' | 'backend' | 'stale' | 'held'>>

/** Live availability, state and loaded materials of one printer row. */
export function liveReplayInfo(
  row: FarmRow,
  keys: FarmKeyState,
  controlEnabled: boolean,
  now: Clock,
  activeSpools: readonly ActiveSpool[] = [],
): LiveReplayInfo {
  const state = row.observation?.state
  const vendor = state?.identity?.vendor
  const online = state?.state !== 'offline'
  const spoolBySlot = new Map(activeSpools.map((spool) => [spool.slot, spool]))
  const observation = row.observation
  const stale =
    row.connection === 'authenticated' &&
    !!observation &&
    (observation.historical ||
      observationAge(observation, clockNotBefore(observation, now)).stale)
  // The Connector advertises this while a finished run awaits collection.
  const held =
    row.connection === 'authenticated' &&
    !stale &&
    state?.controls?.includes('confirm_collection') === true
  return {
    ...(stale ? { stale } : {}),
    ...(held ? { held } : {}),
    connectorOnline: online,
    live:
      online &&
      controlActionAvailability('start_print', row, keys, controlEnabled, now)
        .available,
    ...(state ? { state: controlObservationState(state) } : {}),
    ...(vendor ? { backend: vendor } : {}),
    materials: (state?.materials ?? []).map((m) => {
      const spool = spoolBySlot.get(m.slot)
      return {
        slot: m.slot,
        ...(m.materialType ? { materialType: m.materialType } : {}),
        ...(m.colorHex ? { colorHex: m.colorHex } : {}),
        ...(m.remainingPercent !== undefined
          ? { remainingPercent: m.remainingPercent }
          : {}),
        ...(spool?.remainingPercent !== undefined
          ? { spoolmanRemainingPercent: spool.remainingPercent }
          : {}),
        ...(spool?.colorHex ? { spoolmanColorHex: spool.colorHex } : {}),
      }
    }),
  }
}

/** Live info per printer key; a key that appears twice keeps its first row. */
export function liveReplayIndex(
  rows: readonly FarmRow[],
  keys: FarmKeyState,
  controlEnabled: boolean,
  now: Clock,
  activeSpoolsFor?: (row: FarmRow) => readonly ActiveSpool[],
): ReadonlyMap<string, LiveReplayInfo> {
  const index = new Map<string, LiveReplayInfo>()
  for (const row of rows)
    if (!index.has(row.assignment.printerKey))
      index.set(
        row.assignment.printerKey,
        liveReplayInfo(row, keys, controlEnabled, now, activeSpoolsFor?.(row)),
      )
  return index
}

export type ReplaySend = ((
  printerKey: string,
  args: LibraryPrintArgs,
  selectionCurrent?: () => boolean,
  versionId?: string,
) => Promise<ReplayResult>) & {
  /** Opens and closes a session with the printer; never sends a command. */
  reconnect?: (printerKey: string) => Promise<boolean>
}

/** A ready control session, as far as the replay send needs it. */
export type ReplayControl = {
  issueControlCommand(
    action: 'start_library_print',
    args: LibraryPrintArgs,
  ): Promise<ReplayResult['outcome'] | undefined>
  close(): void
  dispose(): Promise<void>
  /** Actions of the session capability, when the session reports them. */
  admittedActions?: readonly string[]
}

/** Retry only confirmed-unsent attempts that have no explicit refusal. */
export async function sendLibraryReplay(
  connect: (
    onState: (state: FarmPauseControlState) => void,
  ) => Promise<ReplayControl>,
  args: LibraryPrintArgs,
  selectionCurrent: () => boolean = () => true,
): Promise<ReplayResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!selectionCurrent())
      return { outcome: 'not-sent', code: 'stale-selection' }
    let code: string | undefined
    let result: ReplayResult = { outcome: 'not-sent' }
    let control: ReplayControl | undefined
    try {
      control = await connect((state) => {
        if (state.kind === 'settled' && state.code) code = state.code
      })
    } catch {
      if (code) return { outcome: 'not-sent', code }
    }
    if (control) {
      try {
        if (!selectionCurrent())
          return { outcome: 'not-sent', code: 'stale-selection' }
        const outcome = await control.issueControlCommand(
          'start_library_print',
          args,
        )
        result = { outcome: outcome ?? 'not-sent', ...(code ? { code } : {}) }
      } catch {
        result = { outcome: 'outcome-unknown' }
      } finally {
        control.close()
        await control.dispose().catch(() => {})
      }
    }
    if (result.outcome !== 'not-sent' || result.code || attempt === 2)
      return result
    // A Connector serves one command session at a time and waits at least 1 s
    // before it listens again (`RETRY_MIN_MS` in
    // packages/connector/src/runtime/pause-control.ts). The retries outlast
    // that minimum only; its backoff grows to 30 s, which is left to the user.
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
  }
  return { outcome: 'not-sent' }
}
