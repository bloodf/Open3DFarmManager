import { AnycubicStartRefused, startAnycubicPrint } from './files.ts'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import {
  controlTargetState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import {
  readAnycubicPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import {
  buildAnycubicControlCommand,
  anycubicControls,
} from './control-support.ts'
import { createAnycubicControlTransport } from './control-transport.ts'

const lifecycle = (action: ExtendedControlAction | undefined) =>
  action === undefined || ['pause', 'resume', 'cancel'].includes(action)
const Report = z.object({
  data: z.object({
    state: z.enum(['printing', 'paused', 'idle', 'finished', 'error']),
    target_nozzle_temp: z.number().finite().optional().catch(undefined),
    target_hotbed_temp: z.number().finite().optional().catch(undefined),
    fan_speed_pct: z.number().finite().optional().catch(undefined),
    filename: z.string().max(255).optional().catch(undefined),
    lights: z
      .array(
        z.object({
          type: z.number().optional().catch(undefined),
          status: z.number().optional().catch(undefined),
        }),
      )
      .optional()
      .catch(undefined),
  }),
})
type ReportData = z.infer<typeof Report>['data']
// The light the documented `light` request switches (commands.ts, type 3).
const CONTROLLED_LIGHT = 3

/**
 * What the printer itself reported back about the one extended action of this
 * attempt. Absent unless the report carries the requested value, so a report
 * that merely follows the send never confirms it.
 */
function reportedEffect(
  action: ExtendedControlAction | undefined,
  args: Record<string, unknown>,
  data: ReportData,
  observedMono: number,
): ControlObservation['effect'] {
  switch (action) {
    case 'set_temperature': {
      const heater = args.heater
      const target =
        heater === 'extruder'
          ? data.target_nozzle_temp
          : heater === 'bed'
            ? data.target_hotbed_temp
            : undefined
      return (heater === 'extruder' || heater === 'bed') &&
        typeof target === 'number'
        ? { kind: 'temperature', heater, target_c: target, observedMono }
        : undefined
    }
    case 'set_fan':
      return args.fan === 'part' && typeof data.fan_speed_pct === 'number'
        ? {
            kind: 'fan',
            fan: 'part',
            percent: Math.min(100, Math.max(0, data.fan_speed_pct)),
            observedMono,
          }
        : undefined
    case 'set_light': {
      const light = data.lights?.find(
        (entry) => entry.type === CONTROLLED_LIGHT,
      )
      return light && (light.status === 0 || light.status === 1)
        ? { kind: 'light', on: light.status === 1, observedMono }
        : undefined
    }
    case 'start_print':
      return typeof data.filename === 'string'
        ? { kind: 'file', filename: data.filename, observedMono }
        : undefined
    default:
      return undefined
  }
}
export class AnycubicControlTimeout extends Error {
  readonly code = 'BAMBU_CONTROL_TIMEOUT'
  constructor() {
    super('Anycubic control report timeout')
  }
}

/** One guarded request on one local connection. MQTT delivery alone never confirms a command. */
export function openFixedAnycubicControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  timeoutMs?: number
}) {
  const local = readAnycubicPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (
    !local ||
    !anycubicControls(local.modelId).length ||
    !mapping ||
    input.signal.aborted
  )
    throw new Error('Anycubic control unavailable')
  const timeoutMs = input.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error('Invalid Anycubic control timeout')
  let latest: ControlObservation | undefined
  let sequence = 0
  let attempted = false
  let prepared = false
  let stopped = false
  let action: ExtendedControlAction | undefined
  let actionArgs: Record<string, unknown> = {}
  let sentSequence = 0
  let sentMono = 0
  let notify: (() => void) | undefined
  const controller = new AbortController()
  const failure = () => new Error('Anycubic control unavailable')
  function current() {
    if (
      stopped ||
      input.signal.aborted ||
      readAnycubicPrinterBinding(input.binding) !== local
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
  let transport: ReturnType<typeof createAnycubicControlTransport>
  try {
    transport = createAnycubicControlTransport({
      host: local.host,
      port: local.port,
      serial: `${local.modelId}/${local.deviceId}`,
      credentials: {
        username: local.username,
        password: z
          .string()
          .min(1)
          .max(2048)
          .parse(readPrivateJsonFile(local.passwordFile, { maxBytes: 4096 })),
      },
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
          const state = parsed.data.data.state
          const effect =
            attempted && !lifecycle(action)
              ? reportedEffect(action, actionArgs, parsed.data.data, now)
              : undefined
          latest = Object.freeze({
            assignmentId: mapping.assignment_id,
            printerKey: mapping.printer_key,
            connectionGeneration: input.connectionGeneration,
            sequence: ++sequence,
            ready: state !== 'error',
            printState:
              state === 'printing'
                ? 'printing'
                : state === 'paused'
                  ? 'paused'
                  : state === 'error'
                    ? 'error'
                    : action === 'cancel' && attempted
                      ? 'cancelled'
                      : 'idle',
            readyObservedMono: now,
            printStateObservedMono: now,
            receivedMono: now,
            ...(effect ? { effect } : {}),
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
        reject(new AnycubicControlTimeout())
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
   * target print state; an extended action is acknowledged by the first report
   * after the send that carries the requested value, which the dispatcher
   * then compares with the request.
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
    let payload: ReturnType<typeof buildAnycubicControlCommand> | undefined
    try {
      if (next !== 'start_print')
        payload = buildAnycubicControlCommand(next, args)
    } catch {
      throw failure()
    }
    action = next
    actionArgs = args
    sentSequence = sequence
    sentMono = input.clock.monotonicNow()
    const guard = () => {
      current()
      return !request.signal.aborted && request.beforeSend()
    }
    if (next === 'start_print') {
      if (typeof args.file !== 'string')
        throw new AnycubicStartRefused(
          'invalid-command',
          'Invalid Anycubic filename',
        )
      await startAnycubicPrint({
        model: local!.modelId,
        deviceId: local!.deviceId,
        filename: args.file,
        signal: request.signal,
        transport: {
          publish: (topic, wire) => transport.publishFile(topic, wire, guard),
        },
      })
    } else {
      if (!payload) throw failure()
      await transport.publish(payload, guard)
    }
    await wait(
      () =>
        !!latest &&
        latest.sequence > sentSequence &&
        (lifecycle(next)
          ? latest.printState === controlTargetState(next)
          : latest.effect !== undefined),
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
