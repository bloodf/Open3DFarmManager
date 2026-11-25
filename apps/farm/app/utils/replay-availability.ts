// Keeps the two ways a library replay can fail before anything is sent apart:
// the live availability is stale (wait for fresh data and admit again), or the
// signed session handshake failed (say so; only the connection may be retried).
import type { LibraryPrintArgs } from '../../../../packages/farm-protocol/src/control-actions.ts'
import { sendLibraryReplay, type ReplayControl } from './replay-live.ts'
import type { ReplayResult } from './replay-view.ts'
import type { FarmPauseControlState } from './webrtc/farm-pause-control.ts'

/** How long a replay waits for the live status feed to be fresh again. */
export const AVAILABILITY_WAIT_MS = 15_000
const AVAILABILITY_POLL_MS = 250

export type ReplayConnectionFailure =
  'availability-stale' | 'session-handshake-failed'

type Connect = (
  onState: (state: FarmPauseControlState) => void,
) => Promise<ReplayControl>

/**
 * A capability is fixed when the session is admitted, so one issued from stale
 * advertised controls never gains the library start: a new session is needed.
 */
const coversLibraryStart = (control: ReplayControl | undefined) =>
  control?.admittedActions?.includes('start_library_print') ?? true

async function release(control: ReplayControl) {
  control.close()
  await control.dispose().catch(() => {})
}

/** Waits for fresh live availability. Opens nothing and sends nothing. */
async function waitForAvailability(
  isLive: () => boolean,
  current: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!isLive() && current() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, AVAILABILITY_POLL_MS))
  // The send path checks the selection itself, right before the command.
  return isLive()
}

export async function replayWithFreshAvailability(input: {
  isLive: () => boolean
  current: () => boolean
  connect: Connect
  args: LibraryPrintArgs
  waitMs?: number
}): Promise<ReplayResult> {
  const { isLive, current, connect, args } = input
  if (
    !(await waitForAvailability(
      isLive,
      current,
      input.waitMs ?? AVAILABILITY_WAIT_MS,
    ))
  )
    return {
      outcome: 'not-sent',
      code: current() ? 'availability-stale' : 'stale-selection',
    }
  let failure: ReplayConnectionFailure | undefined
  const result = await sendLibraryReplay(
    async (onState) => {
      failure = 'session-handshake-failed'
      const control = await connect(onState)
      if (!coversLibraryStart(control)) {
        failure = 'availability-stale'
        await release(control)
        throw Error('Capability does not cover the library start')
      }
      failure = undefined
      return control
    },
    args,
    current,
  )
  if (result.outcome !== 'not-sent' || result.code) return result
  return { ...result, code: failure ?? 'webrtc-unavailable' }
}

/** Retries the connection only: admits a session, then closes it unused. */
export async function checkReplayConnection(connect: Connect) {
  try {
    const control = await connect(() => {})
    const covered = coversLibraryStart(control)
    await release(control)
    return covered
  } catch {
    return false
  }
}
