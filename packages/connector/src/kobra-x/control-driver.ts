import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import { readKobraClientCertMaterial } from '../config/kobra-x-cert.ts'
import type {
  ControlObservation,
  PauseDriver,
} from '../control/pause-dispatcher.ts'
import {
  readKobraXPrinterBinding,
  readPrinterBinding,
  type PrinterBinding,
} from '../control/printer-binding.ts'
import { record } from './discovery.ts'
import type { KobraXFacts } from './facts.ts'
import { connectKobraX } from './index.ts'
import { reportRefusal, type KobraXReport } from './requests.ts'

export const KOBRA_X_SIGNED_ACTIONS: readonly ExtendedControlAction[] = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
  'set_light',
  'start_print',
  'load_filament',
  'unload_filament',
]

function reportedEffect(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
  { data, type }: KobraXReport,
  observedMono: number,
): ControlObservation['effect'] {
  switch (action) {
    case 'set_temperature': {
      const heater = args.heater
      if (heater !== 'extruder' && heater !== 'bed') return
      const target_c =
        heater === 'extruder'
          ? data.target_nozzle_temp
          : data.target_hotbed_temp
      if (typeof target_c === 'number')
        return { kind: 'temperature', heater, target_c, observedMono }
      return
    }
    case 'set_fan': {
      const percent = (type === 'print' ? record(data.settings) : data)
        .fan_speed_pct
      if (typeof percent === 'number')
        return { kind: 'fan', fan: 'part', percent, observedMono }
      return
    }
    case 'set_light':
      if (data.status === 0 || data.status === 1)
        return { kind: 'light', on: data.status === 1, observedMono }
      return
    case 'load_filament':
      // The native executor matches both box id and loaded slot before this result.
      if (typeof args.tray === 'number')
        return { kind: 'filament', tray: args.tray, observedMono }
      return
    case 'unload_filament':
      return { kind: 'filament', tray: null, observedMono }
  }
}

/** One signed attempt on one fixed, pinned LAN connection. */
export function openFixedKobraXControl(input: {
  binding: PrinterBinding
  connectionGeneration: number
  clock: { monotonicNow(): number }
  publish(observation: ControlObservation | null): void
  signal: AbortSignal
  connect?: typeof connectKobraX
}) {
  const local = readKobraXPrinterBinding(input.binding)
  const mapping = readPrinterBinding(input.binding)
  if (!local || !mapping || input.signal.aborted)
    throw new Error('Kobra X control unavailable')
  const { assignment_id: assignmentId, printer_key: printerKey } = mapping
  let adapter: Awaited<ReturnType<typeof connectKobraX>> | undefined
  let closing: Promise<void> | undefined
  let stopped = false
  let attempted = false
  let latest: ControlObservation | undefined
  let confirmed: ControlObservation | undefined
  let filename: string | undefined
  let currentFacts: KobraXFacts | undefined
  let sequence = 0
  let notify: (() => void) | undefined
  const reportTimes = new WeakMap<KobraXReport, number>()
  const failure = () => new Error('Kobra X control unavailable')
  function stop() {
    if (stopped) return
    stopped = true
    latest = undefined
    input.publish(null)
    notify?.()
    if (adapter) closing = adapter.close()
  }
  input.signal.addEventListener('abort', stop, { once: true })

  function waitFor(predicate: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        notify = undefined
        reject(failure())
      }, 3000)
      notify = () => {
        if (!stopped && !predicate()) return
        clearTimeout(timer)
        notify = undefined
        if (stopped) reject(failure())
        else resolve()
      }
      notify()
    })
  }

  async function send(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    request: Parameters<NonNullable<PauseDriver['execute']>>[2],
  ) {
    if (
      !adapter ||
      stopped ||
      attempted ||
      request.binding !== input.binding ||
      request.signal.aborted
    )
      throw failure()
    attempted = true
    if (
      action === 'load_filament' ||
      action === 'unload_filament' ||
      (action === 'start_print' && args.ams_mapping !== undefined)
    )
      await waitFor(() => !!currentFacts?.boxes.length)
    let sent = false
    const outcome = await adapter.control.execute(action, args, {
      signal: request.signal,
      beforeSend() {
        if (
          stopped ||
          request.signal.aborted ||
          readKobraXPrinterBinding(input.binding) !== local
        )
          return false
        sent = request.beforeSend()
        return sent
      },
    })
    if (outcome.kind !== 'confirmed') {
      if (
        !sent &&
        outcome.kind === 'refused' &&
        outcome.stage === 'local' &&
        outcome.reason !== 'not-authorized'
      )
        throw Object.assign(failure(), {
          refusal: /^(?:invalid-|unknown-slot|tray-required)/.test(
            outcome.reason,
          )
            ? 'invalid-command'
            : /^unsupported-/.test(outcome.reason)
              ? 'unsupported-action'
              : 'state',
        })
      return { acknowledged: false }
    }
    const effectAt = reportTimes.get(outcome.report)
    if (effectAt === undefined || stopped || request.signal.aborted)
      return { acknowledged: false }
    const effect = reportedEffect(action, args, outcome.report, effectAt)
    if (effect || action === 'start_print') {
      // The effect report need not say whether the printer is still ready.
      // Ask for current state once, without resending the command.
      const before = sequence
      adapter.refreshControlState()
      await waitFor(
        () =>
          !!latest &&
          latest.sequence > before &&
          (action !== 'start_print' ||
            (latest.printState === 'printing' && filename === args.file)),
      )
      if (latest)
        confirmed = {
          ...latest,
          effect:
            action === 'start_print' && filename !== undefined
              ? { kind: 'file', filename, observedMono: latest.receivedMono }
              : effect,
        }
    } else {
      confirmed = latest
    }
    return { acknowledged: !!confirmed }
  }

  const driver: PauseDriver = {
    execute: send,
    pauseOnce: (request) =>
      send(request.action ?? 'pause', request.args ?? {}, request),
    async waitForPaused({ binding, after, signal }) {
      if (
        binding !== input.binding ||
        signal.aborted ||
        stopped ||
        !confirmed ||
        confirmed.sequence <= after.sequence ||
        confirmed.connectionGeneration !== after.connectionGeneration ||
        confirmed.receivedMono <= after.sentMono ||
        latest?.printState !== confirmed.printState
      )
        return null
      // The dispatcher aborts its command signal before persisting a confirmed
      // result. Its explicit closeAttempt still closes this connection.
      input.signal.removeEventListener('abort', stop)
      return confirmed
    },
  }
  return {
    driver,
    async prepare() {
      const identity = readKobraClientCertMaterial(local.clientCertFile)
      if (!identity.ok) throw failure()
      adapter = await (input.connect ?? connectKobraX)({
        address: local.host,
        printerKey,
        pinSha256: local.pinSha256,
        expectedIdentity: local,
        clientIdentity: {
          cert: identity.cert.certificatePem,
          key: identity.cert.keyPem,
        },
        reconnectMs: 0,
        signal: input.signal,
        onDisconnect: stop,
        onReport(report, snapshot, facts) {
          if (stopped) return
          currentFacts = facts
          const now = input.clock.monotonicNow()
          reportTimes.set(report, now)
          const { type, data, state, action } = report
          let printState: ControlObservation['printState'] | undefined
          if (type === 'print' && action !== 'getSliceParam') {
            if (state === 'stoped')
              printState =
                reportRefusal(report) === null ? 'cancelled' : 'error'
            else if (state === 'finished') printState = 'idle'
            else if (state === 'paused' || state === 'printing')
              printState = state
            else if (state && state === facts.jobPhase && facts.jobActive)
              printState = 'printing'
          } else if (type === 'info' || type === 'status') {
            if (data.state === 'free' && !facts.jobActive)
              printState =
                snapshot.state === 'error'
                  ? 'error'
                  : latest?.printState === 'cancelled'
                    ? 'cancelled'
                    : 'idle'
            if (data.state === 'busy')
              printState =
                facts.jobActive && facts.jobPhase
                  ? snapshot.state === 'paused'
                    ? 'paused'
                    : 'printing'
                  : 'unknown'
          }
          if (printState) {
            filename = facts.filename
            latest = {
              assignmentId,
              printerKey,
              printState,
              connectionGeneration: input.connectionGeneration,
              sequence: ++sequence,
              ready: printState !== 'error' && printState !== 'unknown',
              readyObservedMono: now,
              printStateObservedMono: now,
              receivedMono: now,
            }
            input.publish(latest)
          }
          notify?.()
        },
      })
      if (stopped || input.signal.aborted) {
        await adapter.close()
        throw failure()
      }
      await waitFor(() => !!latest && currentFacts?.infoState !== undefined)
    },
    async close() {
      input.signal.removeEventListener('abort', stop)
      stop()
      await closing
    },
  }
}
