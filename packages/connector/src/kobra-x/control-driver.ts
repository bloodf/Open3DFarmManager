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
import {
  KOBRA_X_REPORT_WAIT_MS,
  KOBRA_X_SIGNED_ACTIONS,
} from './control-support.ts'

export { KOBRA_X_SIGNED_ACTIONS }

function reportedEffect(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
  { data, type }: KobraXReport,
  observedMono: number,
): ControlObservation['effect'] {
  switch (action) {
    case 'set_temperature': {
      if (type !== 'tempature' && type !== 'print') return
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
      if (type !== 'fan' && type !== 'print') return
      const percent = (type === 'print' ? record(data.settings) : data)
        .fan_speed_pct
      if (typeof percent === 'number')
        return { kind: 'fan', fan: 'part', percent, observedMono }
      return
    }
    case 'set_light':
      if (type === 'light' && (data.status === 0 || data.status === 1))
        return { kind: 'light', on: data.status === 1, observedMono }
      return
    case 'load_filament':
      // The native executor matches both box id and loaded slot before this result.
      if (type === 'multiColorBox' && typeof args.tray === 'number')
        return { kind: 'filament', tray: args.tray, observedMono }
      return
    case 'unload_filament':
      if (type === 'multiColorBox')
        return { kind: 'filament', tray: null, observedMono }
      return
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
  let activeAction: ExtendedControlAction | undefined
  let activeArgs: Record<string, unknown> = {}
  let currentEffect: ControlObservation['effect']
  let ready = false
  let effectCaptured = false
  let confirmedTaskId: string | undefined
  let verifiedTaskId: string | undefined
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
      }, KOBRA_X_REPORT_WAIT_MS)
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
    const previousTaskId = currentFacts?.taskId
    activeAction = action
    activeArgs = args
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
    effectCaptured = true
    const startedTaskId =
      typeof outcome.report.data.taskid === 'string'
        ? outcome.report.data.taskid
        : undefined
    if (
      action === 'start_print' &&
      (!startedTaskId ||
        startedTaskId === '-1' ||
        startedTaskId === previousTaskId)
    )
      return { acknowledged: false }
    if (
      effect ||
      action === 'start_print' ||
      action === 'pause' ||
      action === 'resume' ||
      action === 'cancel'
    ) {
      // The effect report need not say whether the printer is still ready.
      // Ask for current state once, without resending the command.
      const before = sequence
      adapter.refreshControlState()
      await waitFor(
        () =>
          !!latest &&
          latest.sequence > before &&
          (action !== 'start_print' ||
            (latest.printState === 'printing' &&
              filename === args.file &&
              verifiedTaskId === startedTaskId)),
      )
      if (latest) {
        confirmedTaskId = startedTaskId
        confirmed = {
          ...latest,
          effect:
            action === 'start_print' && filename !== undefined
              ? { kind: 'file', filename, observedMono: latest.receivedMono }
              : currentEffect,
        }
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
        latest?.printState !== confirmed.printState ||
        !ready ||
        (confirmed.effect?.kind === 'file' &&
          verifiedTaskId !== confirmedTaskId) ||
        (confirmed.effect !== undefined &&
          confirmed.effect.kind !== 'file' &&
          currentEffect !== confirmed.effect)
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
        onReport(report, snapshot, facts, currentStateQuery) {
          if (stopped) return
          currentFacts = facts
          const now = input.clock.monotonicNow()
          reportTimes.set(report, now)
          const { type, data, state, action } = report
          const successful = reportRefusal(report) === null
          if (
            !successful ||
            ((type === 'info' || type === 'status') &&
              ((data.state === 'busy' && latest?.printState === 'idle') ||
                (data.state === 'free' &&
                  (latest?.printState === 'printing' ||
                    latest?.printState === 'paused')))) ||
            (type === 'print' &&
              ((state === 'printing' && latest?.printState !== 'printing') ||
                (state === 'paused' && latest?.printState !== 'paused') ||
                ((state === 'finished' || state === 'stoped') &&
                  latest?.printState !== 'idle' &&
                  latest?.printState !== 'cancelled')))
          )
            ready = false
          if (currentStateQuery)
            ready =
              successful &&
              (report.code === 0 || report.code === 200) &&
              state === 'done' &&
              (data.state === 'free' || data.state === 'busy') &&
              (data.project == null ||
                (typeof data.project === 'object' &&
                  !Array.isArray(data.project)))
          if (currentStateQuery && ready) {
            const project = record(data.project)
            verifiedTaskId =
              typeof project.taskid === 'string' ? project.taskid : undefined
          }
          if (activeAction && successful) {
            if (
              effectCaptured &&
              type === 'multiColorBox' &&
              (activeAction === 'load_filament' ||
                activeAction === 'unload_filament')
            )
              currentEffect = undefined
            const nextEffect = reportedEffect(
              activeAction,
              activeArgs,
              report,
              now,
            )
            if (
              nextEffect &&
              !(
                effectCaptured &&
                type === 'multiColorBox' &&
                (activeAction === 'load_filament' ||
                  activeAction === 'unload_filament')
              )
            )
              currentEffect = nextEffect
          }
          if (!ready && latest?.ready) {
            latest = { ...latest, ready: false }
            input.publish(latest)
          }
          if (!successful) {
            if (latest) {
              latest = { ...latest, ready: false }
              input.publish(latest)
            }
            notify?.()
            return
          }
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
                  : latest?.printState === 'cancelled' ||
                      (activeAction === 'cancel' && effectCaptured)
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
          if (printState && currentStateQuery && ready) {
            const project = record(data.project)
            filename =
              typeof project.filename === 'string'
                ? project.filename
                : undefined
            latest = {
              assignmentId,
              printerKey,
              printState,
              connectionGeneration: input.connectionGeneration,
              sequence: ++sequence,
              ready:
                ready && printState !== 'error' && printState !== 'unknown',
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
      await waitFor(
        () => !!latest?.ready && ready && currentFacts?.infoState !== undefined,
      )
    },
    async close() {
      input.signal.removeEventListener('abort', stop)
      stop()
      await closing
    },
  }
}
