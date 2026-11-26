/**
 * Guarded Phrozen pause, resume and stop. Reached only through the Connector's
 * signed-command dispatcher: nothing here accepts a wire claim.
 *
 * The wire operations, their preconditions and their confirmation are the
 * adapter's (operations.ts, sources cited there and in
 * docs/fullfarmmanager/evidence/phrozen.md). One write per attempt, never
 * retried. Every refusal before the write is a DriverRefusalError.
 */
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readPrinterBinding,
  readPhrozenPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import { phrozenPrintState } from './operations.ts'
import {
  PHROZEN_START_MESSAGE,
  phrozenUnqualifiedMessage,
  phrozenWriteQualified,
  type PhrozenQualification,
} from './qualification.ts'
import { openPhrozenSession } from './session.ts'

const OPERATIONS = { pause: 'pause', resume: 'resume', cancel: 'stop' } as const
const NOT_SENT =
  'O comando não foi enviado: a impressora não está em condição de recebê-lo.'

export function openFixedPhrozenControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  pollMs?: number
  /** Local composition only; the shipped list is empty. */
  phrozenQualifiedWrites?: readonly PhrozenQualification[] | undefined
}) {
  const local = readPhrozenPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local || !mapping || input.signal.aborted)
    throw new Error('Phrozen control unavailable')
  const controller = new AbortController()
  let adapter: Awaited<ReturnType<typeof openPhrozenSession>> | undefined
  let latest: ControlObservation | undefined
  /** The job seen at preparation: the only one a command may act on. */
  let taskId = ''
  let sequence = 0
  let prepared = false
  let attempted = false
  let stopped = false
  let sentMono = 0
  let action: keyof typeof OPERATIONS | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  const failure = () => new Error('Phrozen control unavailable')

  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(lifetime)
    clearTimeout(poll)
    input.signal.removeEventListener('abort', stop)
    controller.abort()
    latest = undefined
    input.publish(null)
  }
  const lifetime = setTimeout(stop, 30000)
  input.signal.addEventListener('abort', stop, { once: true })

  // One read at a time: an older reply never replaces a newer observation.
  let reading: Promise<unknown> = Promise.resolve()
  function refresh() {
    const next = reading.then(read)
    reading = next.catch(() => undefined)
    return next
  }
  async function read() {
    if (stopped) throw failure()
    const status = await adapter!.readStatus()
    if (stopped) throw failure()
    const seen = phrozenPrintState(status)
    const now = input.clock.monotonicNow()
    latest = Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: seen.state !== 'unknown',
      printState: seen.state,
      readyObservedMono: now,
      printStateObservedMono: now,
      receivedMono: now,
    })
    input.publish(latest)
    return seen
  }

  function schedule() {
    poll = setTimeout(() => {
      // A failed read withdraws the observation: nothing is sent after it.
      void refresh().then(schedule, stop)
    }, input.pollMs ?? 1000)
  }

  async function send(
    next: ExtendedControlAction,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ): Promise<{ acknowledged: boolean }> {
    // After a first attempt a write may already have happened.
    if (attempted) throw failure()
    const refuse = (
      refusal: DriverRefusalError['refusal'],
      message: string,
      userMessage = NOT_SENT,
    ) => new DriverRefusalError(refusal, message, { userMessage })
    if (
      stopped ||
      !prepared ||
      request.binding !== input.binding ||
      request.signal.aborted ||
      readPhrozenPrinterBinding(input.binding) !== local
    )
      throw refuse('state', 'Phrozen control unavailable')
    const { model, firmware } = adapter!.identity
    if (!phrozenWriteQualified(model, firmware, input.phrozenQualifiedWrites))
      throw refuse(
        'unsupported-action',
        `Phrozen writes are not qualified for ${model} firmware ${firmware}`,
        phrozenUnqualifiedMessage(model, firmware),
      )
    if (next === 'start_print')
      throw refuse(
        'unsupported-action',
        'resin-artifact-requires-library-version',
        PHROZEN_START_MESSAGE,
      )
    if (!Object.hasOwn(OPERATIONS, next))
      throw refuse('unsupported-action', 'Phrozen control action unavailable')
    attempted = true
    action = next as keyof typeof OPERATIONS
    let permitted = false
    const result = await adapter![OPERATIONS[action]](taskId, () => {
      if (stopped || request.signal.aborted) return false
      sentMono = input.clock.monotonicNow()
      permitted = request.beforeSend()
      return permitted
    })
    if (result.outcome !== 'confirmed') {
      const message = `Phrozen ${action} ${result.outcome}: ${result.reason}`
      if (!permitted) throw refuse('state', message)
      throw new Error(message)
    }
    await refresh()
    return { acknowledged: true }
  }

  const driver: PauseDriver = {
    execute: (next, _values, request) => send(next, request),
    pauseOnce: (request) => send(request.action ?? 'pause', request),
    async waitForPaused(request) {
      if (
        stopped ||
        request.binding !== input.binding ||
        request.signal.aborted ||
        !action ||
        (request.action !== undefined && request.action !== action) ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        latest.receivedMono <= request.after.sentMono ||
        latest.receivedMono < sentMono ||
        latest.printState !== controlTargetState(action)
      )
        return null
      return latest
    },
  }
  return {
    driver,
    async prepare() {
      if (stopped || prepared) throw failure()
      adapter = await openPhrozenSession(input.binding, {
        signal: controller.signal,
      })
      taskId = (await refresh()).taskId
      prepared = true
      schedule()
    },
    async close() {
      stop()
    },
  }
}
