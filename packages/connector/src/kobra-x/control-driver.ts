import {
  controlSourceState,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
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
import { createKobraXStateEvidence } from './state-evidence.ts'

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
  let commandSent = false
  let latest: ControlObservation | undefined
  let readConfirmation: (() => ControlObservation | undefined) | undefined
  const stateEvidence = createKobraXStateEvidence()
  let currentFacts: KobraXFacts | undefined
  let sequence = 0
  let notify: (() => void) | undefined
  const otherEffects = new Map<string, { report: KobraXReport; time: number }>()
  let watchEffect: ((report: KobraXReport) => void) | undefined
  const effectReports = new Map<
    string,
    {
      report: KobraXReport
      source: 'query' | 'request'
      time: number
    }
  >()
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
    let baseline: ReturnType<typeof stateEvidence.get>
    const outcome = await adapter.control.execute(action, args, {
      signal: request.signal,
      beforeSend() {
        if (
          stopped ||
          !latest?.ready ||
          !controlSourceState(action, latest.printState) ||
          request.signal.aborted ||
          readKobraXPrinterBinding(input.binding) !== local
        )
          return false
        baseline = stateEvidence.get()
        sent = request.beforeSend()
        commandSent = sent
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
    // Telemetry that changed because the command worked is expected here and
    // may have invalidated the pre-send evidence. Confirmation below never
    // reuses it: it waits for fresh correlated replies to new state queries.
    if (stopped || request.signal.aborted || !baseline)
      return { acknowledged: false }

    const commandReport = outcome.report
    const effectType = commandReport.type
    const stateAction =
      action === 'pause' || action === 'resume' || action === 'cancel'
    const refreshEffect =
      !stateAction &&
      action !== 'start_print' &&
      (effectType === 'tempature' ||
        effectType === 'multiColorBox' ||
        effectType === 'print')
    const initialEffect = effectReports.get(effectType)
    const checkEffect =
      stateAction || action === 'start_print'
        ? undefined
        : outcome.effectMatches
    let effectChanged =
      !!checkEffect &&
      !!initialEffect &&
      (reportRefusal(initialEffect.report) !== null ||
        !checkEffect(initialEffect.report))
    const checkReport = (report: KobraXReport) => {
      if (
        report.type === effectType &&
        checkEffect &&
        (reportRefusal(report) !== null || !checkEffect(report))
      )
        effectChanged = true
    }
    if (!stateAction && action !== 'start_print') {
      const other = otherEffects.get(effectType)
      if (other && initialEffect && other.time >= initialEffect.time)
        checkReport(other.report)
      watchEffect = checkReport
    }

    readConfirmation = () => {
      const job = stateEvidence.get()
      if (!latest || !job || effectChanged || stopped || request.signal.aborted)
        return
      if (action === 'start_print') {
        const taskId = commandReport.data.taskid
        const wasIdle =
          baseline?.printState === 'idle' ||
          baseline?.printState === 'cancelled'
        if (
          !wasIdle ||
          job.phase !== 'printing' ||
          job.filename !== args.file ||
          (typeof taskId === 'string' &&
            taskId !== '-1' &&
            job.taskId !== taskId)
        )
          return
        return {
          ...latest,
          effect: {
            kind: 'file',
            filename: job.filename!,
            observedMono: latest.receivedMono,
          },
        }
      }
      if (stateAction) {
        const target =
          action === 'pause'
            ? 'paused'
            : action === 'resume'
              ? 'printing'
              : 'idle'
        if (
          job.printState !== target &&
          !(action === 'cancel' && job.printState === 'cancelled')
        )
          return
        if (
          action !== 'cancel' &&
          baseline?.taskId &&
          job.taskId !== baseline.taskId
        )
          return
        return action === 'cancel'
          ? { ...latest, printState: 'cancelled' }
          : latest
      }
      const observation = effectReports.get(effectType)
      if (
        !observation ||
        (refreshEffect && observation.source !== 'query') ||
        !checkEffect?.(observation.report)
      )
        return
      const effect = reportedEffect(
        action,
        args,
        observation.report,
        observation.time,
      )
      if (!effect) return
      return {
        ...latest,
        effect,
        receivedMono: Math.max(latest.receivedMono, observation.time),
      }
    }

    stateEvidence.reset()
    latest = undefined
    if (refreshEffect) effectReports.delete(effectType)
    adapter.refreshControlState(refreshEffect ? effectType : undefined)
    try {
      await waitFor(
        () =>
          effectChanged ||
          !!readConfirmation?.() ||
          (action === 'start_print' &&
            stateEvidence.get()?.phase === 'printing'),
      )
    } catch {
      return { acknowledged: false }
    }
    return { acknowledged: !!readConfirmation() }
  }

  const driver: PauseDriver = {
    execute: send,
    pauseOnce: (request) =>
      send(request.action ?? 'pause', request.args ?? {}, request),
    async waitForPaused({ binding, after, signal }) {
      const confirmed = readConfirmation?.()
      if (
        binding !== input.binding ||
        signal.aborted ||
        stopped ||
        !confirmed ||
        confirmed.sequence <= after.sequence ||
        confirmed.connectionGeneration !== after.connectionGeneration ||
        confirmed.receivedMono <= after.sentMono
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
        onReport(report, _snapshot, facts, source) {
          if (stopped) return
          currentFacts = facts
          const now = input.clock.monotonicNow()
          watchEffect?.(report)
          if (
            ['print', 'tempature', 'fan', 'light', 'multiColorBox'].includes(
              report.type,
            )
          ) {
            if (source === 'other')
              otherEffects.set(report.type, { report, time: now })
            else effectReports.set(report.type, { report, source, time: now })
          }
          if (
            (source !== 'request' || reportRefusal(report) !== null) &&
            stateEvidence.report(report, source === 'query')
          ) {
            const evidence = stateEvidence.get()
            latest = evidence && {
              assignmentId,
              printerKey,
              printState: evidence.printState,
              connectionGeneration: input.connectionGeneration,
              sequence: ++sequence,
              ready: true,
              readyObservedMono: now,
              printStateObservedMono: now,
              receivedMono: now,
            }
            // After the send, the printer changing state is the command's own
            // effect. Confirmation never reuses the pre-send evidence, so a
            // contradiction only keeps it from confirming. Withdrawing the
            // observation would void a command that was already sent.
            if (latest || (stateEvidence.invalidated() && !commandSent))
              input.publish(latest ?? null)
          }
          notify?.()
        },
      })
      if (stopped || input.signal.aborted) {
        await adapter.close()
        throw failure()
      }
      await waitFor(() => !!latest)
    },
    async close() {
      input.signal.removeEventListener('abort', stop)
      stop()
      await closing
    },
  }
}
