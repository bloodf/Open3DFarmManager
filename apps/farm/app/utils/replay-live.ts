// Live side of replay: what the signed session knows about each printer and
// signed `start_library_print` sessions used by replay.
import type { LibraryPrintArgs } from '../../../../packages/farm-protocol/src/control-actions.ts'
import { controlActionAvailability, type Clock } from './farm-control.ts'
import type { FarmKeyState, FarmRow } from './farm-view.ts'
import type { ReplayPrinter, ReplayResult } from './replay-view.ts'
import type { FarmPauseControlState } from './webrtc/farm-pause-control.ts'

/** The part of a printer the live session decides. */
export type LiveReplayInfo = Pick<
  ReplayPrinter,
  'connectorOnline' | 'live' | 'materials'
> &
  Partial<Pick<ReplayPrinter, 'state' | 'backend'>>

/** Live availability, state and loaded materials of one printer row. */
export function liveReplayInfo(
  row: FarmRow,
  keys: FarmKeyState,
  controlEnabled: boolean,
  now: Clock,
): LiveReplayInfo {
  const state = row.observation?.state
  const vendor = state?.identity?.vendor
  const online = state?.state !== 'offline'
  return {
    connectorOnline: online,
    live:
      online &&
      controlActionAvailability('start_print', row, keys, controlEnabled, now)
        .available,
    ...(state ? { state: state.state } : {}),
    ...(vendor ? { backend: vendor } : {}),
    materials: (state?.materials ?? []).map((m) => ({
      slot: m.slot,
      ...(m.materialType ? { materialType: m.materialType } : {}),
      ...(m.colorHex ? { colorHex: m.colorHex } : {}),
    })),
  }
}

/** Live info per printer key; a key that appears twice keeps its first row. */
export function liveReplayIndex(
  rows: readonly FarmRow[],
  keys: FarmKeyState,
  controlEnabled: boolean,
  now: Clock,
): ReadonlyMap<string, LiveReplayInfo> {
  const index = new Map<string, LiveReplayInfo>()
  for (const row of rows)
    if (!index.has(row.assignment.printerKey))
      index.set(
        row.assignment.printerKey,
        liveReplayInfo(row, keys, controlEnabled, now),
      )
  return index
}

export type ReplaySend = (
  printerKey: string,
  args: LibraryPrintArgs,
  selectionCurrent?: () => boolean,
  versionId?: string,
) => Promise<ReplayResult>

/** A ready control session, as far as the replay send needs it. */
export type ReplayControl = {
  issueControlCommand(
    action: 'start_library_print',
    args: LibraryPrintArgs,
  ): Promise<ReplayResult['outcome'] | undefined>
  close(): void
  dispose(): Promise<void>
}

/** Open a live session and issue at most one signed command. */
export async function sendLibraryReplay(
  connect: (
    onState: (state: FarmPauseControlState) => void,
  ) => Promise<ReplayControl>,
  args: LibraryPrintArgs,
  selectionCurrent: () => boolean = () => true,
): Promise<ReplayResult> {
  if (!selectionCurrent())
    return { outcome: 'not-sent', code: 'stale-selection' }
  let code: string | undefined
  let control: ReplayControl
  try {
    control = await connect((state) => {
      if (state.kind === 'settled' && state.code) code = state.code
    })
  } catch {
    return { outcome: 'not-sent', code: code ?? 'webrtc-unavailable' }
  }
  try {
    if (!selectionCurrent())
      return { outcome: 'not-sent', code: 'stale-selection' }
    const outcome = await control.issueControlCommand(
      'start_library_print',
      args,
    )
    if (outcome === undefined)
      return { outcome: 'not-sent', code: code ?? 'webrtc-unavailable' }
    if (outcome === 'not-sent') return { outcome, code: code ?? 'guard-denied' }
    return { outcome, ...(code ? { code } : {}) }
  } catch {
    return { outcome: 'outcome-unknown' }
  } finally {
    control.close()
    await control.dispose().catch(() => {})
  }
}
