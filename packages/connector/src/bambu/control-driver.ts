import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readBambuPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import { readBambuCredentials } from './credentials.ts'
import { buildBambuCommand } from './commands.ts'
import { createBambuControlTransport } from './control-transport.ts'

const lifecycle = (action: ExtendedControlAction | undefined) =>
  action === undefined || ['pause', 'resume', 'cancel'].includes(action)
const Report = z.object({
  print: z.object({
    gcode_state: z.enum(['RUNNING', 'PAUSE', 'IDLE', 'FINISH', 'FAILED']),
  }),
})
export class BambuControlTimeout extends Error {
  readonly code = 'BAMBU_CONTROL_TIMEOUT'
  constructor() {
    super('Bambu control report timeout')
  }
}

/** One guarded request on one local connection. MQTT delivery alone never confirms a command. */
export function openFixedBambuControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  timeoutMs?: number
}) {
  const local = readBambuPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local?.control || !mapping || input.signal.aborted)
    throw new Error('Bambu control unavailable')
  const timeoutMs = input.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid Bambu control timeout')
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
  const failure = () => new Error('Bambu control unavailable')
  function current() {
    if (
      stopped ||
      input.signal.aborted ||
      readBambuPrinterBinding(input.binding) !== local
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
  let transport: ReturnType<typeof createBambuControlTransport>
  try {
    transport = createBambuControlTransport({
      host: local.host,
      port: local.port,
      serial: local.serial,
      credentials: readBambuCredentials(local),
      ...(local.caFile ? { caPem: readFileSync(local.caFile, 'utf8') } : {}),
      ...(local.pinSha256 ? { pinSha256: local.pinSha256 } : {}),
      limits: {
        maxFrameBytes: 131072,
        connectTimeoutMs: timeoutMs,
        maxInflight: 16,
        reconnectDelayMs: 1000,
        maxReconnects: 0,
      },
      signal: controller.signal,
      onConnection(state) {
        if (state !== 'connected') stop()
      },
      onReport(payload) {
        if (stopped) return
        try {
          const parsed = Report.safeParse(
            parseBoundedJson(payload.toString('utf8'), {
              maxBytes: 131072,
              maxDepth: 16,
              maxValues: 8192,
              maxStringChars: 16384,
            }),
          )
          if (!parsed.success) return
          const now = input.clock.monotonicNow()
          const state = parsed.data.print.gcode_state
          latest = Object.freeze({
            assignmentId: mapping.assignment_id,
            printerKey: mapping.printer_key,
            connectionGeneration: input.connectionGeneration,
            sequence: ++sequence,
            ready: state !== 'FAILED',
            printState:
              state === 'RUNNING'
                ? 'printing'
                : state === 'PAUSE'
                  ? 'paused'
                  : state === 'FAILED'
                    ? 'error'
                    : action === 'cancel' && attempted
                      ? 'cancelled'
                      : 'idle',
            readyObservedMono: now,
            printStateObservedMono: now,
            receivedMono: now,
          })
          input.publish(latest)
          notify?.()
        } catch {
          stop()
        }
      },
    })
  } catch {
    stop()
    throw failure()
  }
  input.signal.addEventListener('abort', stop, { once: true })
  if (input.signal.aborted) stop()
  function wait(predicate: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined
        reject(new BambuControlTimeout())
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
      payload = buildBambuCommand(next, {
        ...args,
        sequence_id: String(input.connectionGeneration),
      })
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
