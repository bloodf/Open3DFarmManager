/**
 * Guarded Flashforge control over the LAN HTTP API. Reached only through the
 * Connector's signed-command dispatcher: nothing here accepts a wire claim.
 *
 * One write per attempt, never retried. `/control` answers success even for a
 * command the firmware ignores (Parallel-7/flashforge-api-docs wiki @ 885702f,
 * HTTP-REST-API.md), so only a later `/detail` read confirms an outcome.
 */
import {
  CameraStreamArguments,
  FilamentSlotArguments,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readFlashforgePrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import { readFlashforgeCredentials } from './config.ts'
import { createFlashforgeAdapter, flashforgeSlotMatches } from './index.ts'
import {
  FLASHFORGE_CONTROLS,
  FLASHFORGE_QUALIFIED_WRITES,
  flashforgeWritesQualified,
  type FlashforgeQualification,
} from './qualification.ts'

type Adapter = ReturnType<typeof createFlashforgeAdapter>
type Status = Awaited<ReturnType<Adapter['readStatus']>>
type Mutation = Parameters<Adapter['execute']>[0]
type Effect = NonNullable<ControlObservation['effect']>

/** A load moves filament, so its readback gets the dispatcher's widest window. */
export const FLASHFORGE_LOAD_WINDOW_MS = 24_000

const NOT_QUALIFIED =
  'Os comandos desta impressora Flashforge ainda não foram qualificados para este modelo e firmware.'
const NOT_READY = 'A impressora não está em um estado que aceite este comando.'
const CAMERA_NEEDED =
  'A câmera não pode ser desligada durante uma impressão, para não interromper o monitoramento remoto.'
/** The only reports that show no job in progress. */
const NO_JOB = ['ready', 'completed', 'cancel']

export function flashforgeUnqualifiedMessage() {
  return NOT_QUALIFIED
}

function printState(status: string): ControlObservation['printState'] {
  if (status === 'printing') return 'printing'
  if (status === 'pause') return 'paused'
  if (status === 'ready' || status === 'completed') return 'idle'
  if (status === 'cancel') return 'cancelled'
  return status === 'error' ? 'error' : 'unknown'
}

/** The one adapter mutation for a signed action, or a typed refusal. */
function mutation(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
): Mutation {
  const invalid = (message: string, userMessage: string) =>
    new DriverRefusalError('invalid-command', message, { userMessage })
  switch (action) {
    case 'pause':
    case 'resume':
    case 'cancel':
      return { kind: action }
    case 'set_temperature': {
      // The 5M series ignores `chamber`; the AD5X has no heated chamber.
      if (args.heater !== 'extruder' && args.heater !== 'bed')
        throw invalid(
          'Flashforge chamber target unsupported',
          'Esta impressora não permite ajustar a temperatura da câmara.',
        )
      const maximum = args.heater === 'bed' ? 100 : 265
      const celsius = args.target_c
      if (
        typeof celsius !== 'number' ||
        !Number.isInteger(celsius) ||
        celsius < 0 ||
        celsius > maximum
      )
        throw invalid(
          'Flashforge temperature denied',
          `A temperatura deve ficar entre 0 e ${maximum} °C.`,
        )
      return {
        kind: 'temperature',
        heater: args.heater === 'bed' ? 'bed' : 'nozzle',
        celsius,
      }
    }
    case 'set_fan':
      if (args.fan !== 'part' || typeof args.percent !== 'number')
        throw invalid(
          'Flashforge fan unsupported',
          'Somente o ventilador da peça pode ser ajustado nesta impressora.',
        )
      return { kind: 'fan', percent: args.percent }
    case 'load_filament':
      // The signed tray index is 0-based; the station's slots are 1-4.
      if (
        typeof args.tray !== 'number' ||
        !Number.isInteger(args.tray) ||
        args.tray < 0 ||
        args.tray > 3
      )
        throw invalid(
          'Flashforge slot required',
          'Escolha um dos quatro compartimentos da estação de materiais.',
        )
      return { kind: 'slot-load', slot: args.tray + 1 }
    case 'set_camera_stream': {
      const parsed = CameraStreamArguments.safeParse(args)
      if (!parsed.success)
        throw invalid(
          'Flashforge camera argument denied',
          'Informe se a transmissão da câmara deve ser ligada ou desligada.',
        )
      return { kind: 'camera', on: parsed.data.on }
    }
    case 'set_filament_slot': {
      const parsed = FilamentSlotArguments.safeParse(args)
      if (!parsed.success)
        throw invalid(
          'Flashforge slot record denied',
          'Escolha um compartimento, um material da lista e uma cor.',
        )
      const { tray, material, color } = parsed.data
      return { kind: 'slot-config', slot: tray + 1, material, color }
    }
    default:
      throw new DriverRefusalError(
        'unsupported-action',
        'Flashforge control action unavailable',
      )
  }
}

export function openFixedFlashforgeControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  timeoutMs?: number
  pollMs?: number
  /** Tests only. Production composition uses the shipped list, which is empty. */
  qualifiedWrites?: readonly FlashforgeQualification[] | undefined
}) {
  const local = readFlashforgePrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local || !mapping || input.signal.aborted)
    throw new Error('Flashforge control unavailable')
  const timeoutMs = input.timeoutMs ?? 5000
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > FLASHFORGE_LOAD_WINDOW_MS
  )
    throw new Error('Invalid Flashforge control timeout')
  const origin = new URL(local.origin)
  const qualifiedWrites = input.qualifiedWrites ?? FLASHFORGE_QUALIFIED_WRITES
  const adapter = createFlashforgeAdapter({
    host: origin.hostname,
    port: Number(origin.port),
    timeoutMs: Math.min(timeoutMs, 3000),
    qualifiedWrites,
    ...readFlashforgeCredentials(local),
  })
  let latest: ControlObservation | undefined
  let report: Status | undefined
  let sequence = 0
  let attempted = false
  let prepared = false
  let stopped = false
  let sent: { action: ExtendedControlAction; mutation: Mutation } | undefined
  /** Set once the write is acknowledged; only later reads can confirm it. */
  let confirmAfter: number | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let notify: (() => void) | undefined
  const controller = new AbortController()
  const failure = () => new Error('Flashforge control unavailable')
  function current() {
    if (
      stopped ||
      input.signal.aborted ||
      readFlashforgePrinterBinding(input.binding) !== local
    )
      throw failure()
  }
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(lifetime)
    clearTimeout(poll)
    input.signal.removeEventListener('abort', stop)
    controller.abort()
    latest = undefined
    input.publish(null)
    notify?.()
  }
  const lifetime = setTimeout(stop, 30000)

  function effect(status: Status, observedMono: number): Effect | undefined {
    if (!sent || confirmAfter === undefined || observedMono <= confirmAfter)
      return
    const next = sent.mutation
    if (next.kind === 'temperature') {
      const heater = next.heater === 'bed' ? status.bed : status.nozzle
      if (heater.target !== next.celsius) return
      return {
        kind: 'temperature',
        heater: next.heater === 'bed' ? 'bed' : 'extruder',
        target_c: next.celsius,
        observedMono,
      }
    }
    if (next.kind === 'fan') {
      if (status.coolingFanPercent !== next.percent) return
      return {
        kind: 'fan',
        fan: 'part',
        percent: next.percent,
        observedMono,
      }
    }
    if (next.kind === 'camera') {
      if (!(next.on ? status.cameraUrl : status.cameraDisabled)) return
      return { kind: 'camera-stream', on: next.on, observedMono }
    }
    if (next.kind === 'slot-config') {
      const slot = status.slots?.find((entry) => entry.id === next.slot)
      if (!slot || !flashforgeSlotMatches(slot, next.material, next.color))
        return
      return {
        kind: 'filament-slot',
        tray: next.slot - 1,
        material: next.material,
        color: next.color,
        observedMono,
      }
    }
    // The station returns to idle after the load, with the slot active.
    if (
      next.kind === 'slot-load' &&
      status.station?.stateAction === 0 &&
      status.station.currentSlot === next.slot
    )
      return { kind: 'filament', tray: next.slot - 1, observedMono }
  }

  async function refresh() {
    // Timed from the request, so a read that began before the write can never
    // confirm it.
    const startedMono = input.clock.monotonicNow()
    try {
      const status = await adapter.readStatus(controller.signal)
      if (stopped) return
      if (status.model !== local!.expect.model) throw failure()
      report = status
      const now = input.clock.monotonicNow()
      const confirmed = effect(status, startedMono)
      const state = printState(status.status)
      latest = Object.freeze({
        assignmentId: mapping!.assignment_id,
        printerKey: mapping!.printer_key,
        connectionGeneration: input.connectionGeneration,
        sequence: ++sequence,
        ready: state !== 'error',
        printState: state,
        readyObservedMono: startedMono,
        printStateObservedMono: startedMono,
        receivedMono: now,
        ...(confirmed ? { effect: confirmed } : {}),
      })
      input.publish(latest)
      notify?.()
      poll = setTimeout(() => void refresh(), input.pollMs ?? 500)
    } catch {
      stop()
    }
  }
  input.signal.addEventListener('abort', stop, { once: true })
  void refresh()

  function wait(predicate: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined
        reject(new Error('Flashforge control report timeout'))
      }, ms)
      const check = () => {
        if (!stopped && !predicate()) return
        clearTimeout(timer)
        notify = undefined
        if (stopped) reject(failure())
        else resolve()
      }
      notify = check
      check()
    })
  }

  function confirmed(): boolean {
    if (!sent || !latest || confirmAfter === undefined) return false
    if (latest.printStateObservedMono <= confirmAfter) return false
    switch (sent.action) {
      case 'pause':
        return latest.printState === 'paused'
      case 'resume':
        return latest.printState === 'printing'
      case 'cancel':
        return latest.printState === 'cancelled'
      default:
        return latest.effect !== undefined
    }
  }

  async function send(
    action: ExtendedControlAction,
    values: Record<string, unknown>,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ): Promise<{ acknowledged: boolean }> {
    // Untyped: after a first attempt, a write may already have happened.
    if (attempted) throw failure()
    if (
      stopped ||
      !prepared ||
      !report ||
      request.binding !== input.binding ||
      request.signal.aborted ||
      readFlashforgePrinterBinding(input.binding) !== local
    )
      throw new DriverRefusalError('state', 'Flashforge control unavailable', {
        userMessage: NOT_READY,
      })
    if (!FLASHFORGE_CONTROLS[local!.expect.model].includes(action))
      throw new DriverRefusalError(
        'unsupported-action',
        'Flashforge control action unavailable',
      )
    const unqualified = () =>
      new DriverRefusalError(
        'unsupported-action',
        'Flashforge writes are not qualified for this model and firmware',
        { userMessage: NOT_QUALIFIED },
      )
    const qualified = (status: Status) =>
      flashforgeWritesQualified(status.model, status.firmware, qualifiedWrites)
    if (!qualified(report)) throw unqualified()
    const next = mutation(action, values)
    attempted = true
    let guarded = false
    let refused: DriverRefusalError | undefined
    try {
      // The adapter reads `/detail` again and calls this on the sending stack.
      await adapter.execute(next, (observation) => {
        if (!qualified(observation)) {
          refused = unqualified()
          return false
        }
        // The camera is the remote view of a print: judged on the fresh read.
        if (
          next.kind === 'camera' &&
          !next.on &&
          !NO_JOB.includes(observation.status)
        ) {
          refused = new DriverRefusalError(
            'state',
            'Flashforge camera stays on during a job',
            { userMessage: CAMERA_NEEDED },
          )
          return false
        }
        if (
          stopped ||
          request.signal.aborted ||
          observation.model !== local!.expect.model ||
          readFlashforgePrinterBinding(input.binding) !== local
        )
          return false
        guarded = true
        sent = { action, mutation: next }
        return request.beforeSend()
      })
    } catch (error) {
      if (guarded || error instanceof DriverRefusalError) throw error
      throw (
        refused ??
        new DriverRefusalError('state', 'Flashforge command refused', {
          cause: error,
          userMessage: NOT_READY,
        })
      )
    }
    confirmAfter = input.clock.monotonicNow()
    await wait(
      confirmed,
      action === 'load_filament'
        ? Math.max(timeoutMs, FLASHFORGE_LOAD_WINDOW_MS - 2000)
        : timeoutMs,
    )
    return { acknowledged: true }
  }

  const driver: PauseDriver = {
    execute: (action, values, request) => send(action, values, request),
    pauseOnce: (request) => send(request.action ?? 'pause', {}, request),
    async waitForPaused(request) {
      current()
      if (
        request.binding !== input.binding ||
        request.signal.aborted ||
        !sent ||
        (request.action !== undefined && request.action !== sent.action) ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        latest.receivedMono <= request.after.sentMono ||
        !confirmed()
      )
        return null
      return latest
    },
  }
  return {
    driver,
    async prepare() {
      current()
      if (prepared) throw failure()
      await wait(() => !!latest, timeoutMs)
      current()
      prepared = true
    },
    async close() {
      stop()
    },
  }
}
