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
import { buildCrealityCommand } from './commands.ts'
const lifecycle = (action: ExtendedControlAction | undefined) =>
  action === undefined || ['pause', 'resume', 'cancel'].includes(action)
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
  let sentSequence = 0
  let sentMono = 0
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
    async publish(payload: unknown, guard: () => boolean) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !guard())
        throw failure()
      socket.send(JSON.stringify(payload))
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
  function onMessage(data: WebSocket.RawData, binary: boolean) {
    if (stopped || binary) return
    const report = decodeCrealityStatus(data.toString())
    if (!report?.state) return
    const now = input.clock.monotonicNow()
    latest = Object.freeze({
      assignmentId: mapping!.assignment_id,
      printerKey: mapping!.printer_key,
      connectionGeneration: input.connectionGeneration,
      sequence: ++sequence,
      ready: report.state !== 'error',
      printState:
        action === 'cancel' && attempted && report.state === 'idle'
          ? 'cancelled'
          : report.state,
      readyObservedMono: now,
      printStateObservedMono: now,
      receivedMono: now,
    })
    input.publish(latest)
    notify?.()
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
   * The single request of this attempt. Lifecycle actions are confirmed by their
   * target print state; an extended action has no print-state target, so it is
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
    let payload: unknown
    try {
      payload = buildCrealityCommand(next, args)
    } catch {
      throw failure()
    }
    action = next
    sentSequence = sequence
    sentMono = input.clock.monotonicNow()
    await transport.publish(payload, () => {
      current()
      return !request.signal.aborted && request.beforeSend()
    })
    await wait(
      () =>
        !!latest &&
        latest.sequence > sentSequence &&
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
