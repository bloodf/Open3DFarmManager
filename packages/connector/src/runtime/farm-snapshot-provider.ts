import type {
  RawMoonrakerObservation,
  RawMoonrakerUnavailable,
} from '../moonraker/subscription.ts'
import type {
  FarmSnapshotProvider,
  CompleteFarmSnapshot,
} from '../webrtc/farm-status-sender.ts'
import {
  snapshotAssignmentRefs,
  validatedStatusMessage,
  runSynchronous,
  type AssignmentRef,
} from '../webrtc/readonly-session.ts'
import { PrinterState } from '../../../farm-protocol/src/state.ts'

/** Display evidence only. No enrollment, command permission, or wall-clock authority. */
export function createFarmSnapshotSource(input: {
  assignmentRefs: readonly AssignmentRef[]
  nowMono?: () => number
}) {
  if (input.assignmentRefs.length < 1 || input.assignmentRefs.length > 16)
    throw Error('Configured assignment bound')
  const refs = snapshotAssignmentRefs(
    input.assignmentRefs,
    input.assignmentRefs[0]!.agentId,
  )
  const nowMono = input.nowMono ?? (() => performance.now())
  const entries = new Map<string, RawMoonrakerObservation>()
  const epochs = new Map<string, number>()
  const retired = new Map<string, number>()
  const listeners = new Set<() => void>()
  let closed = false,
    lastNow = -1
  function clock() {
    const now = nowMono()
    if (!Number.isFinite(now) || now < 0 || now < lastNow) {
      close()
      throw Error('Monotonic clock invalid')
    }
    lastNow = now
    return now
  }
  function notify() {
    for (const listener of [...listeners]) listener()
  }
  function close() {
    if (closed) return
    closed = true
    entries.clear()
    notify()
    listeners.clear()
  }
  function snapshot(
    now: number,
    deadline: number,
  ): CompleteFarmSnapshot | undefined {
    let captured = Infinity,
      until = deadline
    const printers = []
    for (const ref of refs) {
      const entry = entries.get(ref.printerKey)
      if (!entry) return
      const times = Object.values(entry.fieldObservedAtMonoMs)
      captured = Math.min(captured, ...times)
      until = Math.min(until, ...times.map((time) => time + 5000))
      const temperature = entry.temperatureObservation
      const tool = temperature?.fields.tool,
        bed = temperature?.fields.bed
      const hasReading = tool?.kind === 'reading' || bed?.kind === 'reading'
      if (temperature && hasReading) {
        captured = Math.min(captured, temperature.observedAtMonoMs)
        until = Math.min(until, temperature.observedAtMonoMs + 5000)
      }
      printers.push(
        PrinterState.parse({
          ...entry.printer,
          ...(tool?.kind === 'reading'
            ? { toolTemperatureCelsius: tool.celsius }
            : {}),
          ...(bed?.kind === 'reading'
            ? { bedTemperatureCelsius: bed.celsius }
            : {}),
        }),
      )
    }
    if (until <= now) return
    // Include worst-case sequence width, JSON escaping and UTF8 framing in cap.
    const message = validatedStatusMessage(
      { t: 'snapshot', seq: 1024, printers },
      refs,
    )
    return Object.freeze({
      assignmentRefs: refs,
      complete: true,
      printers: message.printers,
      capturedAtMonoMs: captured,
      validUntilMonoMs: until,
    })
  }
  function invalidate(event: RawMoonrakerUnavailable) {
    if (closed || !refs.some((ref) => ref.printerKey === event.printerKey))
      return
    if (!Number.isSafeInteger(event.epoch) || event.epoch < 1) {
      close()
      return
    }
    if (event.epoch < (epochs.get(event.printerKey) ?? 0)) return
    retired.set(
      event.printerKey,
      Math.max(retired.get(event.printerKey) ?? 0, event.epoch),
    )
    epochs.set(event.printerKey, event.epoch)
    entries.delete(event.printerKey)
    notify()
  }
  function observe(value: RawMoonrakerObservation) {
    if (closed) return
    const now = clock()
    if (!refs.some((ref) => ref.printerKey === value.printerKey)) {
      close()
      throw Error('Unconfigured printer')
    }
    const previous = entries.get(value.printerKey)
    if (!Number.isSafeInteger(value.epoch) || value.epoch < 1) {
      close()
      throw Error('Invalid epoch')
    }
    if (
      value.epoch <= (retired.get(value.printerKey) ?? 0) ||
      value.epoch < (epochs.get(value.printerKey) ?? 0)
    )
      return
    if (previous && value.epoch > previous.epoch) {
      invalidate({ printerKey: value.printerKey, epoch: previous.epoch })
    }
    const times = value.fieldObservedAtMonoMs
    if (
      Object.keys(times).sort().join(',') !== 'printState,progress,webhooks' ||
      !Number.isFinite(value.receivedAtMonoMs) ||
      value.receivedAtMonoMs > now ||
      (['webhooks', 'printState', 'progress'] as const).some((field) => {
        const time = times[field]
        return (
          !Number.isFinite(time) ||
          time < 0 ||
          time > value.receivedAtMonoMs ||
          (previous?.epoch === value.epoch &&
            time < previous.fieldObservedAtMonoMs[field])
        )
      })
    ) {
      invalidate({ printerKey: value.printerKey, epoch: value.epoch })
      throw Error('Invalid observation time')
    }
    const temperature =
      value.temperatureObservation ??
      (previous?.epoch === value.epoch
        ? previous.temperatureObservation
        : undefined)
    if (
      temperature &&
      (!Number.isFinite(temperature.observedAtMonoMs) ||
        temperature.observedAtMonoMs < 0 ||
        temperature.observedAtMonoMs > value.receivedAtMonoMs ||
        (previous?.epoch === value.epoch &&
          previous.temperatureObservation &&
          temperature.observedAtMonoMs <
            previous.temperatureObservation.observedAtMonoMs))
    ) {
      invalidate({ printerKey: value.printerKey, epoch: value.epoch })
      throw Error('Invalid temperature observation time')
    }
    const parsedPrinter = PrinterState.safeParse(value.printer)
    if (!parsedPrinter.success) {
      invalidate({ printerKey: value.printerKey, epoch: value.epoch })
      throw Error('Invalid printer snapshot')
    }
    // Only separately stamped complete evidence can add display temperatures.
    const printer = PrinterState.parse({
      printerKey: parsedPrinter.data.printerKey,
      state: parsedPrinter.data.state,
      progress: parsedPrinter.data.progress,
      observedAt: parsedPrinter.data.observedAt,
    })
    if (printer.printerKey !== value.printerKey) {
      close()
      throw Error('Printer mismatch')
    }
    entries.set(
      value.printerKey,
      Object.freeze({
        ...value,
        printer: Object.freeze(printer),
        fieldObservedAtMonoMs: Object.freeze({ ...times }),
        ...(temperature
          ? {
              temperatureObservation: Object.freeze({
                observedAtMonoMs: temperature.observedAtMonoMs,
                fields: Object.freeze({
                  tool: Object.freeze({ ...temperature.fields.tool }),
                  bed: Object.freeze({ ...temperature.fields.bed }),
                }),
              }),
            }
          : {}),
      }),
    )
    epochs.set(value.printerKey, value.epoch)
    notify()
  }
  const open: FarmSnapshotProvider = (options) => {
    let terminal = false,
      timer: ReturnType<typeof setTimeout> | undefined
    function stop(unavailable: boolean) {
      if (terminal) return
      terminal = true
      clearTimeout(timer)
      listeners.delete(update)
      options.signal.removeEventListener('abort', abort)
      if (unavailable) runSynchronous(options.onUnavailable)
    }
    function abort() {
      stop(false)
    }
    function update() {
      if (terminal) return
      clearTimeout(timer)
      try {
        if (closed || options.signal.aborted) {
          stop(!options.signal.aborted)
          return
        }
        const now = clock()
        if (
          !Number.isFinite(options.deadlineMonoMs) ||
          options.deadlineMonoMs <= now
        ) {
          stop(true)
          return
        }
        const value = snapshot(now, options.deadlineMonoMs)
        if (!value) {
          stop(true)
          return
        }
        timer = setTimeout(update, Math.max(1, value.validUntilMonoMs - now))
        runSynchronous(() => options.onComplete(value))
      } catch {
        stop(true)
      }
    }
    if (listeners.size !== 0) throw Error('One provider per source')
    const expected = snapshotAssignmentRefs(
      options.assignmentRefs,
      refs[0]!.agentId,
    )
    if (
      expected.length !== refs.length ||
      refs.some(
        (ref) =>
          !expected.some(
            (other) =>
              other.assignmentId === ref.assignmentId &&
              other.agentId === ref.agentId &&
              other.printerKey === ref.printerKey,
          ),
      )
    )
      throw Error('Exact configured scope required')
    if (options.binding.agent_id !== refs[0]!.agentId)
      throw Error('Admission agent mismatch')
    listeners.add(update)
    options.signal.addEventListener('abort', abort, { once: true })
    update()
    return { close: () => stop(false) }
  }
  return { observe, invalidate, open, close }
}
