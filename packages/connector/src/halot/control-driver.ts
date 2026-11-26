/**
 * Guarded HALOT pause, resume and stop. Reached only through the Connector's
 * signed-command dispatcher. One frame per attempt, never retried; only a later
 * status reply confirms it (docs/protocols/halot.md, "Commands").
 */
import { setTimeout as delay } from 'node:timers/promises'
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readHalotPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import { readHalotPassword } from './config.ts'
import {
  halotControls,
  halotUnqualifiedMessage,
  HALOT_START_MESSAGE,
  type HalotQualification,
  type HalotWrite,
} from './qualification.ts'
import { openHalotSession, type HalotSession } from './session.ts'
import { halotStatus } from './status.ts'

const NOT_SENT =
  'O comando não foi enviado: a impressora não está em condição de recebê-lo.'

/** `PRINT_PAUSE` toggles, so each action requires its own starting words. */
const OPERATIONS: Record<
  HalotWrite,
  {
    command: 'PRINT_PAUSE' | 'PRINT_STOP'
    from: readonly string[]
    /** Words that confirm the effect. */
    reached: readonly string[]
  }
> = {
  pause: {
    command: 'PRINT_PAUSE',
    from: ['PRINT_PROCESSING'],
    reached: ['PRINT_PAUSE', 'PRINT_STOP'],
  },
  resume: {
    command: 'PRINT_PAUSE',
    from: ['PRINT_PAUSE', 'PRINT_STOP'],
    reached: ['PRINT_PROCESSING'],
  },
  // PRINT_STOP may mean paused, so it never confirms a stop.
  cancel: {
    command: 'PRINT_STOP',
    from: ['PRINT_PROCESSING', 'PRINT_PAUSE', 'PRINT_STOP'],
    reached: ['PRINT_END', 'PRINT_GENERAL'],
  },
}

// An unconfirmed write holds every later one to that printer until the
// Connector restarts: a late pause followed by another would resume the job.
const held = new WeakSet<PrinterBinding>()

/** Inside the dispatcher's result window. */
const CONFIRM_TIMEOUT_MS = 4000

export function openFixedHalotControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  pollMs?: number
  confirmTimeoutMs?: number
  /** Local composition only; the shipped list is empty. */
  halotQualifiedWrites?: readonly HalotQualification[] | undefined
}) {
  const local = readHalotPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local || !mapping || input.signal.aborted)
    throw new Error('HALOT control unavailable')
  const controller = new AbortController()
  let session: HalotSession | undefined
  let latest: ControlObservation | undefined
  let wire = ''
  let filename = ''
  /** The job seen at preparation: the only one a command may act on. */
  let preparedFile = ''
  let sequence = 0
  let prepared = false
  let attempted = false
  let stopped = false
  let confirmed: HalotWrite | undefined
  let sentMono = 0
  let poll: ReturnType<typeof setTimeout> | undefined
  const failure = () => new Error('HALOT control unavailable')

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
  const lifetime = setTimeout(stop, 30_000)
  input.signal.addEventListener('abort', stop, { once: true })

  // One read at a time: the protocol pairs no reply with its request.
  let reading: Promise<unknown> = Promise.resolve()
  function refresh() {
    const next = reading.then(read)
    reading = next.catch(() => undefined)
    return next
  }
  async function read() {
    if (stopped) throw failure()
    const reply = await session!.readStatus()
    if (stopped) throw failure()
    wire = reply.printStatus
    filename = reply.filename ?? ''
    const state =
      confirmed === 'cancel' ? 'cancelled' : halotStatus(reply).state
    const now = input.clock.monotonicNow()
    latest = Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: state !== 'unknown' && state !== 'error',
      printState: state,
      readyObservedMono: now,
      printStateObservedMono: now,
      receivedMono: now,
    })
    input.publish(latest)
  }

  function schedule() {
    poll = setTimeout(() => {
      // A failed read withdraws the observation: nothing is sent after it.
      void refresh().then(schedule, stop)
    }, input.pollMs ?? 1000)
  }

  async function send(
    action: ExtendedControlAction,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ): Promise<{ acknowledged: boolean }> {
    // After a first attempt a frame may already have left.
    if (attempted) throw failure()
    const refuse = (
      refusal: DriverRefusalError['refusal'],
      message: string,
      userMessage = NOT_SENT,
    ) => new DriverRefusalError(refusal, message, { userMessage })
    if (action === 'start_print' || action === 'start_library_print')
      throw refuse(
        'unsupported-action',
        'HALOT upload and start are not implemented',
        HALOT_START_MESSAGE,
      )
    const model = local!.expect.model
    const allowed = halotControls(model, input.halotQualifiedWrites)
    if (!(allowed as readonly string[]).includes(action))
      throw refuse(
        'unsupported-action',
        `HALOT ${action} is not qualified for ${model}`,
        halotUnqualifiedMessage(model),
      )
    const name = action as HalotWrite
    const operation = OPERATIONS[name]
    if (
      stopped ||
      !prepared ||
      request.binding !== input.binding ||
      request.signal.aborted ||
      readHalotPrinterBinding(input.binding) !== local
    )
      throw refuse('state', 'HALOT control unavailable')
    if (held.has(input.binding))
      throw refuse(
        'state',
        'HALOT uncertain result unacknowledged',
        'O resultado do comando anterior não foi confirmado. Confira a impressora e reinicie o Connector.',
      )
    attempted = true
    try {
      await refresh()
    } catch {
      throw refuse('state', 'HALOT status is unavailable')
    }
    if (filename !== preparedFile || !operation.from.includes(wire))
      throw refuse('state', `HALOT ${name} does not apply to ${wire}`)
    let permitted: boolean | undefined
    const sent = session!.write(operation.command, () => {
      if (stopped || request.signal.aborted) return false
      sentMono = input.clock.monotonicNow()
      permitted = request.beforeSend()
      return permitted
    })
    if (!sent) {
      if (permitted === false) throw failure()
      throw refuse('state', 'HALOT command was not sent')
    }
    // Held from the send until a status reply confirms the effect.
    held.add(input.binding)
    const deadline =
      performance.now() + (input.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS)
    // Reads only. A command is never sent again.
    for (;;) {
      await refresh()
      if (
        operation.reached.includes(wire) &&
        // A stopped job keeps its name or none; another name is another job.
        (filename === preparedFile || (name === 'cancel' && !filename))
      )
        break
      if (performance.now() >= deadline)
        throw new Error(`HALOT ${name} uncertain: state unconfirmed`)
      await delay(Math.min(input.pollMs ?? 250, 250), undefined, {
        signal: controller.signal,
      })
    }
    held.delete(input.binding)
    confirmed = name
    await refresh()
    return { acknowledged: true }
  }

  const driver: PauseDriver = {
    execute: (action, _values, request) => send(action, request),
    pauseOnce: (request) => send(request.action ?? 'pause', request),
    async waitForPaused(request) {
      if (
        stopped ||
        request.binding !== input.binding ||
        request.signal.aborted ||
        !confirmed ||
        (request.action !== undefined && request.action !== confirmed) ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        latest.receivedMono <= request.after.sentMono ||
        latest.receivedMono < sentMono ||
        latest.printState !== controlTargetState(confirmed)
      )
        return null
      return latest
    },
  }
  return {
    driver,
    async prepare() {
      if (stopped || prepared) throw failure()
      const origin = new URL(local.origin)
      session = await openHalotSession({
        host: origin.hostname,
        port: Number(origin.port || 80),
        password: readHalotPassword(local),
        timeoutMs: 2500,
        signal: controller.signal,
      })
      await refresh()
      preparedFile = filename
      prepared = true
      schedule()
    },
    async close() {
      stop()
    },
  }
}
