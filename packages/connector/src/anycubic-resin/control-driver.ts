/**
 * Guarded Photon P1 Max job stop over the collection's open session. Reached
 * only through the Connector's signed-command dispatcher. One publish per
 * attempt, never retried; only the printer's own stop report confirms it.
 */
import {
  readPhotonResinPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import { RESIN_LIBRARY_START_MESSAGE } from '../sdcp/models.ts'
import type { PhotonResinSessions } from './collection.ts'
import {
  photonResinWriteQualified,
  type PhotonResinQualification,
} from './qualification.ts'
import { photonResinRefusals } from './session.ts'
import { photonResinStatus } from './status.ts'

const unqualified =
  'Photon LAN writes are not qualified for this model and firmware'

/** Why an action is not offered: a technical reason and the operator's text. */
function photonResinRefusal(action: ExtendedControlAction): {
  reason: string
  userMessage: string
} {
  if (action === 'pause' || action === 'resume')
    return {
      reason: photonResinRefusals[action],
      userMessage:
        'A Photon P1 Max não tem pausa ou retomada comprovada pela rede.',
    }
  if (action === 'start_print' || action === 'start_library_print')
    return {
      reason: `resin-artifact-requires-library-version. ${photonResinRefusals.upload}`,
      userMessage: RESIN_LIBRARY_START_MESSAGE,
    }
  if (action === 'cancel')
    return {
      reason: unqualified,
      userMessage:
        'O cancelamento nesta impressora de resina ainda não foi qualificado.',
    }
  return {
    reason: 'No cited Photon P1 Max operation for this action',
    userMessage: 'Comando não suportado por esta impressora de resina.',
  }
}

/** The pre-write refusal of an action that is not offered right now. */
export function photonResinRefusalError(
  action: ExtendedControlAction,
  stopQualified: boolean,
) {
  // A qualified stop is withheld only by the printer's current state.
  if (action === 'cancel' && stopQualified)
    return new DriverRefusalError(
      'state',
      'The printer reports no stoppable job',
    )
  const { reason, userMessage } = photonResinRefusal(action)
  return new DriverRefusalError('unsupported-action', reason, { userMessage })
}

export function openFixedPhotonResinControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  photonResinSessions?: PhotonResinSessions | undefined
  /** Local composition only; the shipped list is empty. */
  photonResinQualifiedWrites?: readonly PhotonResinQualification[] | undefined
  pollMs?: number
}) {
  const local = readPhotonResinPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  const sessions = input.photonResinSessions
  const session = local && sessions?.get(local.printerKey)
  if (!local || !mapping || !session || input.signal.aborted)
    throw new Error('Photon resin control unavailable')
  const failure = () => new Error('Photon resin control unavailable')
  const refuse = () =>
    new DriverRefusalError('state', 'Photon resin control unavailable')
  let latest: ControlObservation | undefined
  let sequence = 0
  let reportedAt = -1
  let sentMono = 0
  let prepared = false
  let attempted = false
  let cancelled = false
  let stopped = false
  let poll: ReturnType<typeof setInterval> | undefined
  function current() {
    return (
      !stopped &&
      !input.signal.aborted &&
      readPhotonResinPrinterBinding(input.binding) === local &&
      sessions!.get(local!.printerKey) === session &&
      session!.state().connected
    )
  }
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(lifetime)
    clearInterval(poll)
    input.signal.removeEventListener('abort', stop)
    latest = undefined
    input.publish(null)
  }
  const lifetime = setTimeout(stop, 30_000)
  /** Publishes only a newer printer report, or the confirmed stop. */
  function observe() {
    if (!current()) return stop()
    const state = session!.state()
    const observedAt = state.printer?.observedAt
    if (observedAt === undefined || (!cancelled && observedAt === reportedAt))
      return
    reportedAt = observedAt
    const status = photonResinStatus(state, Date.now())
    const now = input.clock.monotonicNow()
    const seen = cancelled
      ? now
      : Math.max(0, now - Math.max(0, Date.now() - observedAt))
    latest = Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: true,
      printState: cancelled ? 'cancelled' : status.state,
      readyObservedMono: seen,
      printStateObservedMono: seen,
      receivedMono: now,
    })
    input.publish(latest)
  }
  input.signal.addEventListener('abort', stop, { once: true })

  async function send(
    action: ExtendedControlAction,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ): Promise<{ acknowledged: boolean }> {
    // Untyped: after a first attempt, a write may already have happened.
    if (attempted) throw failure()
    const qualified = photonResinWriteQualified(
      'print-stop',
      local!.model,
      input.photonResinQualifiedWrites,
    )
    if (action !== 'cancel' || !qualified)
      throw photonResinRefusalError(action, qualified)
    if (
      !prepared ||
      request.binding !== input.binding ||
      request.signal.aborted ||
      !current()
    )
      throw refuse()
    const job = photonResinStatus(session!.state(), Date.now()).stoppableJob
    if (!job)
      throw new DriverRefusalError(
        'state',
        'The printer reports no stoppable job',
      )
    attempted = true
    let allowed: boolean | undefined
    // The session reads fresh status first, then calls the guard on the same
    // stack as its single publish.
    const result = await session!.stopPrint(job.filename, () => {
      if (request.signal.aborted || !current()) return false
      allowed = request.beforeSend()
      sentMono = input.clock.monotonicNow()
      return allowed
    })
    if (allowed === false) throw failure()
    if (allowed === undefined)
      throw new DriverRefusalError(
        'state',
        result.outcome === 'confirmed'
          ? 'Photon resin control unavailable'
          : result.reason,
      )
    if (result.outcome !== 'confirmed') throw new Error(result.reason)
    cancelled = true
    observe()
    return { acknowledged: true }
  }

  const driver: PauseDriver = {
    execute: (action, _args, request) => send(action, request),
    pauseOnce: (request) => send(request.action ?? 'pause', request),
    async waitForPaused(request) {
      if (
        !current() ||
        request.binding !== input.binding ||
        request.signal.aborted ||
        !cancelled ||
        (request.action !== undefined && request.action !== 'cancel') ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        latest.receivedMono <= request.after.sentMono ||
        latest.receivedMono < sentMono
      )
        return null
      return latest
    },
  }
  return {
    driver,
    async prepare() {
      if (prepared || !current()) throw failure()
      await session.refresh()
      observe()
      if (!latest) throw failure()
      poll = setInterval(observe, input.pollMs ?? 250)
      prepared = true
    },
    async close() {
      stop()
    },
  }
}
