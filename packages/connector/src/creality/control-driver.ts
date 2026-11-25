import WebSocket from 'ws'
import { resolveCrealityEndpoint } from '../discovery/creality.ts'
import { decodeCrealityStatus } from './index.ts'
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readCrealityPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import {
  buildCrealityCommand,
  buildCrealitySpeedFrames,
  CREALITY_SPEED_PERCENT,
  CrealityRefused,
  type CrealitySpeedLevel,
} from './commands.ts'
import {
  buildCrealityFilamentCommand,
  checkCrealityFeed,
  CREALITY_BOXES_REQUEST,
  CREALITY_FEED_DONE,
  CREALITY_RETRACT_DONE,
  readCrealityCfsSlots,
} from './filament.ts'
const lifecycle = (action: ExtendedControlAction | undefined) =>
  action === undefined || ['pause', 'resume', 'cancel'].includes(action)
const feeding = (action: ExtendedControlAction | undefined) =>
  action === 'load_filament' || action === 'unload_filament'
/** Actions whose printer reports say whether they took effect. */
const confirmable = (action: ExtendedControlAction) =>
  action === 'set_speed' || feeding(action)
/** Status fields kept across partial frames to guard and confirm commands. */
const TRACKED = [
  'model',
  'speedMode',
  'curFeedratePct',
  'sleepMode',
  'feedState',
  'boxsInfo',
] as const
type Tracked = (typeof TRACKED)[number]
export class CrealityControlTimeout extends Error {
  readonly code = 'CREALITY_CONTROL_TIMEOUT'
  constructor() {
    super('Creality control report timeout')
  }
}

/** One guarded request on one local connection. MQTT delivery alone never confirms a command. */
export function openFixedCrealityControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  timeoutMs?: number
}) {
  const local = readCrealityPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local || !mapping || input.signal.aborted)
    throw new Error('Creality control unavailable')
  const timeoutMs = input.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid Creality control timeout')
  let latest: ControlObservation | undefined
  let sequence = 0
  let attempted = false
  let prepared = false
  let stopped = false
  let action: ExtendedControlAction | undefined
  let actionArgs: Record<string, unknown> = {}
  let sentSequence = 0
  let sentMono = 0
  let sent = false
  let reportsSpeedMode = false
  const known: Partial<Record<Tracked, { value: unknown; frame: number }>> = {}
  let frames = 0
  let sentFrame = 0
  let state: { value: ControlObservation['printState']; mono: number }
  let confirmedMono: number | undefined
  let notify: (() => void) | undefined
  const controller = new AbortController()
  let failureReason = 'Creality control unavailable'
  const failure = () => new Error(failureReason)
  function current() {
    if (
      stopped ||
      input.signal.aborted ||
      readCrealityPrinterBinding(input.binding) !== local
    )
      throw failure()
  }
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(lifetime)
    input.signal.removeEventListener('abort', stop)
    controller.abort()
    latest = undefined
    input.publish(null)
    notify?.()
  }
  const lifetime = setTimeout(stop, 30000)
  let socket: WebSocket | undefined
  const transport = {
    /** One command: every frame of it leaves on this same synchronous stack. */
    async publish(payloads: readonly unknown[], guard: () => boolean) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !guard())
        throw failure()
      for (const payload of payloads) socket.send(JSON.stringify(payload))
    },
    close() {
      if (!socket || socket.readyState === WebSocket.CLOSED)
        return Promise.resolve()
      return new Promise<void>((resolve) => {
        socket!.once('close', resolve)
        socket!.terminate()
      })
    },
  }
  controller.signal.addEventListener('abort', () => socket?.terminate(), {
    once: true,
  })
  async function connect() {
    try {
      const endpoint = await resolveCrealityEndpoint(local!)
      if (stopped) return
      const host = local!.host.includes(':') ? `[${local!.host}]` : local!.host
      socket = new WebSocket(
        `${endpoint.secure ? 'wss' : 'ws'}://${host}:${endpoint.port}`,
        {
          ...(endpoint.ca ? { ca: endpoint.ca } : {}),
          maxPayload: 65536,
          handshakeTimeout: timeoutMs,
          perMessageDeflate: false,
        },
      )
      socket.on('error', stop)
      socket.on('close', stop)
      socket.on('message', onMessage)
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error)
      stop()
    }
  }
  /** Whether reports received after the send show the requested effect. */
  function confirmed(): boolean {
    const fresh = (field: Tracked, value: unknown) =>
      known[field]?.value === value && known[field]!.frame > sentFrame
    if (action === 'load_filament')
      return fresh('feedState', CREALITY_FEED_DONE)
    if (action === 'unload_filament')
      return fresh('feedState', CREALITY_RETRACT_DONE)
    if (action !== 'set_speed') return false
    const level = actionArgs.level as CrealitySpeedLevel
    if (reportsSpeedMode && level === 'silent') return fresh('speedMode', 1)
    return (
      fresh('curFeedratePct', CREALITY_SPEED_PERCENT[level]) &&
      (!reportsSpeedMode || known.speedMode?.value === 0)
    )
  }
  function effect(): ControlObservation['effect'] {
    if (!sent || !action || !confirmable(action)) return undefined
    if (confirmedMono === undefined) {
      if (!confirmed()) return undefined
      confirmedMono = input.clock.monotonicNow()
    }
    return action === 'set_speed'
      ? {
          kind: 'speed',
          level: actionArgs.level as CrealitySpeedLevel,
          observedMono: confirmedMono,
        }
      : {
          kind: 'filament',
          tray: action === 'load_filament' ? (actionArgs.tray as number) : null,
          observedMono: confirmedMono,
        }
  }
  function onMessage(data: WebSocket.RawData, binary: boolean) {
    if (stopped || binary) return
    const text = data.toString()
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    if (!raw || typeof raw !== 'object') return
    frames++
    for (const field of TRACKED)
      if (Object.hasOwn(raw, field))
        known[field] = { value: raw[field], frame: frames }
    const report = decodeCrealityStatus(text)
    if (report?.state)
      state = { value: report.state, mono: input.clock.monotonicNow() }
    const done = effect()
    // A frame without a state publishes only to deliver a confirmation.
    if (!state || (!report?.state && !done)) return notify?.()
    const now = input.clock.monotonicNow()
    latest = Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: state.value !== 'error',
      printState:
        action === 'cancel' && attempted && state.value === 'idle'
          ? 'cancelled'
          : state.value,
      readyObservedMono: state.mono,
      printStateObservedMono: state.mono,
      receivedMono: now,
      ...(done ? { effect: done } : {}),
    })
    input.publish(latest)
    notify?.()
  }
  /** Guards `next` against the reports and builds the frames of one command. */
  async function plan(
    next: ExtendedControlAction,
    args: Record<string, unknown>,
  ): Promise<readonly unknown[]> {
    if (next === 'set_speed') {
      reportsSpeedMode = known.speedMode !== undefined
      // Maker UI: Sleep Mode blocks speed changes; F022 allows them only
      // while printing.
      if (known.sleepMode?.value === 1)
        throw new CrealityRefused('state', 'Creality Sleep Mode is on')
      if (known.model?.value === 'F022' && latest?.printState !== 'printing')
        throw new CrealityRefused(
          'state',
          'This model changes speed only while printing',
        )
      return buildCrealitySpeedFrames(args, reportsSpeedMode)
    }
    if (feeding(next)) {
      if (local!.cfsFeed !== true)
        throw new CrealityRefused(
          'unsupported-action',
          'Creality CFS feed is not enabled for this printer',
        )
      checkCrealityFeed({
        action: next,
        args,
        model: known.model?.value,
        feedState: known.feedState?.value,
      })
      // A read, not the command: slot reports are only sent when asked.
      const before = frames
      if (socket?.readyState !== WebSocket.OPEN) throw failure()
      socket.send(JSON.stringify(CREALITY_BOXES_REQUEST))
      try {
        await wait(() => (known.boxsInfo?.frame ?? 0) > before)
      } catch (error) {
        if (!(error instanceof CrealityControlTimeout)) throw error
        throw new CrealityRefused('state', 'Creality CFS did not report slots')
      }
      current()
      // The feeder may have started while the slots were being read.
      checkCrealityFeed({
        action: next,
        args,
        model: known.model?.value,
        feedState: known.feedState?.value,
      })
      return [
        buildCrealityFilamentCommand(
          next,
          args,
          readCrealityCfsSlots(known.boxsInfo?.value),
        ),
      ]
    }
    try {
      return [buildCrealityCommand(next, args)]
    } catch {
      throw failure()
    }
  }
  void connect()
  input.signal.addEventListener('abort', stop, { once: true })
  if (input.signal.aborted) stop()
  function wait(predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined
        reject(new CrealityControlTimeout())
      }, timeoutMs)
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
  /**
   * The single command of this attempt. Lifecycle actions are confirmed by their
   * target print state; speed and CFS feed by their own reports (a feed usually
   * outlasts this wait, which leaves the result unknown). Any other action is
   * acknowledged by the first report received after the send. That proves the
   * printer kept serving this connection, not that the setting took effect.
   */
  async function send(
    next: ExtendedControlAction,
    args: Record<string, unknown>,
    request: Parameters<PauseDriver['pauseOnce']>[0],
  ): Promise<{ acknowledged: boolean }> {
    current()
    if (
      !prepared ||
      attempted ||
      request.binding !== input.binding ||
      request.signal.aborted
    )
      throw failure()
    attempted = true
    const payloads = await plan(next, args)
    current()
    if (request.signal.aborted) throw failure()
    action = next
    actionArgs = args
    sentSequence = sequence
    sentFrame = frames
    sentMono = input.clock.monotonicNow()
    await transport.publish(payloads, () => {
      current()
      return (sent = !request.signal.aborted && request.beforeSend())
    })
    await wait(
      () =>
        !!latest &&
        latest.sequence > sentSequence &&
        (!confirmable(next) || !!latest.effect) &&
        (!lifecycle(next) || latest.printState === controlTargetState(next)),
    )
    return { acknowledged: true }
  }
  const driver: PauseDriver = {
    execute: (next, args, request) => send(next, args, request),
    pauseOnce: (request) => send(request.action ?? 'pause', {}, request),
    async waitForPaused(request) {
      current()
      if (
        request.binding !== input.binding ||
        request.signal.aborted ||
        (request.action !== undefined && request.action !== action) ||
        !latest ||
        latest.sequence <= request.after.sequence ||
        latest.connectionGeneration !== request.after.connectionGeneration ||
        (lifecycle(action) &&
          latest.printState !== controlTargetState(action ?? 'pause')) ||
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
      current()
      if (prepared) throw failure()
      await wait(() => !!latest)
      current()
      prepared = true
    },
    close() {
      stop()
      return transport.close()
    },
  }
}
