import { PRINTER_STRING_MAX_UNITS } from '@open3dfarmmanager/farm-protocol'
import type { MacroParamMap } from '../moonraker/control-macros.ts'
import type { ExtendedControlAction } from '../../../farm-protocol/src/control-actions.ts'
import { moonrakerLastJob } from '../moonraker/normalize.ts'
import { moonrakerFilamentUsage } from './job-filament-usage.ts'
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
import type { SpoolmanSnapshot } from './spoolman-provider.ts'
import {
  inventoryAt,
  summarizeSpoolman,
  type SpoolSummaryState,
} from './spool-inventory.ts'

/** A disconnected response observes connection only, never print telemetry. */
export type RawPrinterObservation = Omit<
  RawMoonrakerObservation,
  'status' | 'fieldObservedAtMonoMs'
> &
  Partial<Pick<RawMoonrakerObservation, 'status'>> & {
    firmwareObservation?: Readonly<{
      firmware: NonNullable<PrinterState['firmware']>
      observedAtMonoMs: number
    }>
    materialsObservation?: Readonly<{
      materials: NonNullable<PrinterState['materials']>
      observedAtMonoMs: number
    }>
    fieldObservedAtMonoMs:
      | RawMoonrakerObservation['fieldObservedAtMonoMs']
      | Readonly<{ connection: number }>
      | Readonly<{
          bambu: Readonly<Partial<Record<keyof PrinterState, number>>>
        }>
      | Readonly<{
          creality: Readonly<Partial<Record<keyof PrinterState, number>>>
        }>
      | Readonly<{
          prusaLink: Readonly<Partial<Record<keyof PrinterState, number>>>
        }>
      | Readonly<{
          formlabs: Readonly<Partial<Record<keyof PrinterState, number>>>
        }>
      | Readonly<{
          sdcp: Readonly<Partial<Record<keyof PrinterState, number>>>
        }>
      | Readonly<{
          anycubic: Readonly<Partial<Record<keyof PrinterState, number>>>
        }>
  }

function fieldTimes(timing: RawPrinterObservation['fieldObservedAtMonoMs']) {
  if ('prusaLink' in timing) return timing.prusaLink
  if ('formlabs' in timing) return timing.formlabs
  return 'sdcp' in timing
    ? timing.sdcp
    : 'anycubic' in timing
      ? timing.anycubic
      : 'bambu' in timing
        ? timing.bambu
        : 'creality' in timing
          ? timing.creality
          : timing
}

const FRAME_LIMIT = 'Application frame limit'

/** Display evidence only. No enrollment, command permission, or wall-clock authority. */
export function createFarmSnapshotSource(input: {
  assignmentRefs: readonly AssignmentRef[]
  linkHealthFor?: (printerKey: string) => PrinterState['linkHealth']
  nowMono?: () => number
  macrosFor?: (assignmentId: string) => readonly string[] | undefined
  macroParamsFor?: (assignmentId: string) => MacroParamMap | undefined
  controlsFor?: (
    assignmentId: string,
  ) => readonly ExtendedControlAction[] | undefined
  localWebUiOriginFor?: (assignmentId: string) => string | undefined
}) {
  if (input.assignmentRefs.length < 1 || input.assignmentRefs.length > 16)
    throw Error('Configured assignment bound')
  const refs = snapshotAssignmentRefs(
    input.assignmentRefs,
    input.assignmentRefs[0]!.agentId,
  )
  const nowMono = input.nowMono ?? (() => performance.now())
  const entries = new Map<string, RawPrinterObservation>()
  const epochs = new Map<string, number>()
  const retired = new Map<string, number>()
  // Last finished job per printer. Outlives epochs so a reconnect or the next
  // print never erases it; `rearmed` marks that a new job ran since it was set.
  const lastJobs = new Map<string, NonNullable<PrinterState['lastJob']>>()
  const rearmed = new Set<string>()
  let spoolState: { value: SpoolSummaryState; receivedMono: number } | undefined
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
    lastJobs.clear()
    rearmed.clear()
    notify()
    listeners.clear()
  }
  function snapshot(
    now: number,
    deadline: number,
  ): { wakeAt: number; value: CompleteFarmSnapshot } | undefined {
    let captured = Infinity,
      until = deadline,
      wakeAt = deadline
    const printers = []
    for (const ref of refs) {
      const entry = entries.get(ref.printerKey)
      if (!entry) return
      const timing = fieldTimes(entry.fieldObservedAtMonoMs)
      const optional =
        'anycubic' in entry.fieldObservedAtMonoMs
          ? ([
              'identity',
              'statusReason',
              'filename',
              'currentLayer',
              'totalLayer',
              'estimatedRemainingSeconds',
              'toolTemperatureCelsius',
              'bedTemperatureCelsius',
            ] as const)
          : []
      const independent: readonly string[] = [
        'alarms',
        'fans',
        'light',
        'materials',
        ...optional,
      ]
      const times = Object.entries(timing)
        .filter(([key]) => !independent.includes(key))
        .map(([, time]) => time)
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
      const macros = input.macrosFor?.(ref.assignmentId)
      const macroParams = macros?.length
        ? input.macroParamsFor?.(ref.assignmentId)
        : undefined
      const controls = input.controlsFor?.(ref.assignmentId)
      const advertisedControls =
        controls !== undefined ? { controls: [...controls] } : {}
      const {
        controls: _untrustedControls,
        macros: _untrustedMacros,
        macroParams: _untrustedMacroParams,
        firmware: _untrustedFirmware,
        // Machine profiles travel by telemetry; the live frame is size-capped.
        machine: _machine,
        lastJob: _observedLastJob,
        linkHealth: _observedLinkHealth,
        ...observedPrinter
      } = entry.printer
      const printer: PrinterState = { ...observedPrinter }
      const linkHealth = input.linkHealthFor?.(ref.printerKey)
      if (linkHealth) printer.linkHealth = linkHealth
      const localWebUiOrigin = input.localWebUiOriginFor?.(ref.assignmentId)
      if (
        localWebUiOrigin &&
        localWebUiOrigin.length <= PRINTER_STRING_MAX_UNITS
      )
        printer.localWebUiOrigin = localWebUiOrigin
      const lastJob = lastJobs.get(ref.printerKey)
      if (lastJob) printer.lastJob = lastJob
      for (const field of [
        'alarms',
        'fans',
        'light',
        'materials',
        ...optional,
      ] as const) {
        if (field in timing) {
          const stamp = Object.entries(timing).find(
            ([key]) => key === field,
          )![1]
          if (stamp + 5000 <= now) delete printer[field]
          else if (
            field === 'alarms' ||
            'anycubic' in entry.fieldObservedAtMonoMs
          )
            wakeAt = Math.min(wakeAt, stamp + 5000)
          else until = Math.min(until, stamp + 5000)
        }
      }
      const firmware = entry.firmwareObservation
      if (firmware && firmware.observedAtMonoMs + 600_000 > now) {
        printer.firmware = firmware.firmware
        until = Math.min(until, firmware.observedAtMonoMs + 600_000)
      }
      const material = entry.materialsObservation
      if (material && material.observedAtMonoMs + 5000 > now) {
        printer.materials = material.materials
        until = Math.min(until, material.observedAtMonoMs + 5000)
      }
      printers.push(
        PrinterState.parse({
          ...printer,
          ...advertisedControls,
          ...(macros !== undefined ? { macros: [...macros] } : {}),
          ...(macroParams && Object.keys(macroParams).length
            ? { macroParams }
            : {}),
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
    // Fit as many spools as the frame cap allows; the total stays truthful.
    let message
    try {
      message = validatedStatusMessage(
        { t: 'snapshot', seq: 1024, printers },
        refs,
      )
    } catch (error) {
      if (!(error instanceof Error && error.message === FRAME_LIMIT))
        throw error
      if (!printers.some((printer) => printer.linkHealth)) throw error
      for (const printer of printers) delete printer.linkHealth
      message = validatedStatusMessage(
        { t: 'snapshot', seq: 1024, printers },
        refs,
      )
    }
    if (spoolState) {
      const elapsed = now - spoolState.receivedMono
      for (let n = spoolState.value.spools.length; n >= 0; n--) {
        try {
          message = validatedStatusMessage(
            {
              t: 'snapshot',
              seq: 1024,
              printers,
              inventory: inventoryAt(spoolState.value, elapsed, Date.now(), n),
            },
            refs,
          )
          break
        } catch (error) {
          // Only the frame cap shrinks the list; anything else is a real fault.
          if (!(error instanceof Error && error.message === FRAME_LIMIT))
            throw error
        }
      }
    }
    return {
      wakeAt,
      value: Object.freeze({
        assignmentRefs: refs,
        complete: true,
        printers: message.printers,
        ...(message.inventory ? { inventory: message.inventory } : {}),
        capturedAtMonoMs: captured,
        validUntilMonoMs: until,
      }),
    }
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
  function observe(value: RawPrinterObservation) {
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
    const timing = value.fieldObservedAtMonoMs
    const fieldStamped =
      'prusaLink' in timing ||
      'formlabs' in timing ||
      'sdcp' in timing ||
      'anycubic' in timing ||
      'bambu' in timing ||
      'creality' in timing
    const times = fieldTimes(timing)
    const connectionOnly = 'connection' in times
    const previousTiming = previous?.fieldObservedAtMonoMs
    const previousTimes = previousTiming
      ? fieldTimes(previousTiming)
      : undefined
    const expectedFields = fieldStamped
      ? [
          'state',
          ...(
            [
              'identity',
              'statusReason',
              'preformStatus',
              'alarms',
              'progress',
              'filename',
              'materials',
              'currentLayer',
              'totalLayer',
              'estimatedRemainingSeconds',
              'toolTemperatureCelsius',
              'bedTemperatureCelsius',
              'fans',
              'light',
            ] as const
          ).filter((field) => value.printer[field] !== undefined),
        ]
          .sort()
          .join(',')
      : connectionOnly
        ? 'connection'
        : 'printState,progress,webhooks'
    if (
      Object.keys(times).sort().join(',') !== expectedFields ||
      (connectionOnly &&
        (value.printer.state !== 'offline' ||
          value.printer.progress !== undefined)) ||
      !Number.isFinite(value.receivedAtMonoMs) ||
      value.receivedAtMonoMs > now ||
      Object.entries(times).some(([field, time]) => {
        const previousTime =
          previousTimes &&
          Object.entries(previousTimes).find(([key]) => key === field)?.[1]
        const boundaryTime =
          previousTimes &&
          ('connection' in previousTimes !== connectionOnly ||
            (!!previousTiming &&
              ('prusaLink' in previousTiming ||
                'formlabs' in previousTiming ||
                'sdcp' in previousTiming ||
                'anycubic' in previousTiming ||
                'bambu' in previousTiming ||
                'creality' in previousTiming)) !== fieldStamped)
            ? Math.max(...Object.values(previousTimes))
            : previousTime
        return (
          !Number.isFinite(time) ||
          time < 0 ||
          time > value.receivedAtMonoMs ||
          (previous?.epoch === value.epoch &&
            boundaryTime !== undefined &&
            time < boundaryTime)
        )
      })
    ) {
      invalidate({ printerKey: value.printerKey, epoch: value.epoch })
      throw Error('Invalid observation time')
    }
    const temperature =
      connectionOnly || fieldStamped
        ? undefined
        : (value.temperatureObservation ??
          (previous?.epoch === value.epoch
            ? previous.temperatureObservation
            : undefined))
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
    if (
      value.materialsObservation &&
      (!Number.isFinite(value.materialsObservation.observedAtMonoMs) ||
        value.materialsObservation.observedAtMonoMs < 0 ||
        value.materialsObservation.observedAtMonoMs > value.receivedAtMonoMs ||
        !PrinterState.shape.materials.safeParse(
          value.materialsObservation.materials,
        ).success)
    ) {
      invalidate({ printerKey: value.printerKey, epoch: value.epoch })
      throw Error('Invalid materials observation')
    }
    const firmware = value.firmwareObservation
    if (
      firmware &&
      (!Number.isFinite(firmware.observedAtMonoMs) ||
        firmware.observedAtMonoMs < 0 ||
        firmware.observedAtMonoMs > value.receivedAtMonoMs ||
        !PrinterState.shape.firmware.safeParse(firmware.firmware).success)
    )
      throw Error('Invalid firmware observation')
    const parsedPrinter = PrinterState.safeParse(value.printer)
    if (!parsedPrinter.success) {
      invalidate({ printerKey: value.printerKey, epoch: value.epoch })
      throw Error('Invalid printer snapshot')
    }
    const active =
      parsedPrinter.data.state === 'printing' ||
      parsedPrinter.data.state === 'paused'
    if (active) {
      lastJobs.delete(value.printerKey)
      rearmed.add(value.printerKey)
    }
    const observedFinished =
      parsedPrinter.data.lastJob ??
      (!fieldStamped && !connectionOnly && value.status
        ? moonrakerLastJob(value.status, parsedPrinter.data.observedAt)
        : undefined)
    const finished =
      observedFinished?.filamentUsedMillimetres !== undefined &&
      observedFinished.filamentUsage === undefined
        ? {
            ...observedFinished,
            filamentUsage: [
              moonrakerFilamentUsage(
                observedFinished.filamentUsedMillimetres,
                value.materialsObservation?.materials,
              ),
            ],
          }
        : observedFinished
    if (finished && !active) {
      const known = lastJobs.get(value.printerKey)
      // The same terminal state is re-observed every poll; keep its first endedAt.
      const repeat =
        known !== undefined &&
        !rearmed.has(value.printerKey) &&
        known.outcome === finished.outcome &&
        known.filename === finished.filename &&
        known.printDuration === finished.printDuration &&
        known.totalDuration === finished.totalDuration
      if (!repeat) {
        lastJobs.set(value.printerKey, Object.freeze({ ...finished }))
        rearmed.delete(value.printerKey)
      }
    }
    // Bambu and Creality fields carry their own stamps; Moonraker temperatures use separate evidence.
    const printer = PrinterState.parse({
      ...(fieldStamped
        ? (({ lastJob: _lastJob, machine: _machine, ...rest }) => rest)(
            parsedPrinter.data,
          )
        : {}),
      printerKey: parsedPrinter.data.printerKey,
      state: parsedPrinter.data.state,
      ...(parsedPrinter.data.statusMessage
        ? { statusMessage: parsedPrinter.data.statusMessage }
        : {}),
      ...(parsedPrinter.data.preformStatus
        ? { preformStatus: parsedPrinter.data.preformStatus }
        : {}),
      ...(parsedPrinter.data.statusReason
        ? { statusReason: parsedPrinter.data.statusReason }
        : {}),
      ...(parsedPrinter.data.fans ? { fans: parsedPrinter.data.fans } : {}),
      ...(parsedPrinter.data.light ? { light: parsedPrinter.data.light } : {}),
      // The raw chamber reading is live evidence and stays current even when
      // durable telemetry records are rate limited.
      ...(parsedPrinter.data.chamberTemperatureCelsius === undefined
        ? {}
        : {
            chamberTemperatureCelsius:
              parsedPrinter.data.chamberTemperatureCelsius,
          }),
      ...(parsedPrinter.data.progress === undefined
        ? {}
        : { progress: parsedPrinter.data.progress }),
      ...(parsedPrinter.data.identity
        ? { identity: Object.freeze({ ...parsedPrinter.data.identity }) }
        : {}),
      observedAt: parsedPrinter.data.observedAt,
    })
    if (printer.printerKey !== value.printerKey) {
      close()
      throw Error('Printer mismatch')
    }
    const { temperatureObservation: _temperature, ...observation } = value
    entries.set(
      value.printerKey,
      Object.freeze({
        ...observation,
        ...(firmware
          ? {
              firmwareObservation: Object.freeze({
                observedAtMonoMs: firmware.observedAtMonoMs,
                firmware: structuredClone(firmware.firmware),
              }),
            }
          : {}),
        ...(value.materialsObservation
          ? {
              materialsObservation: Object.freeze({
                observedAtMonoMs: value.materialsObservation.observedAtMonoMs,
                materials: structuredClone(
                  value.materialsObservation.materials,
                ),
              }),
            }
          : {}),
        printer: Object.freeze(printer),
        fieldObservedAtMonoMs:
          'anycubic' in timing
            ? Object.freeze({ anycubic: Object.freeze({ ...timing.anycubic }) })
            : 'bambu' in timing
              ? Object.freeze({ bambu: Object.freeze({ ...timing.bambu }) })
              : 'creality' in timing
                ? Object.freeze({
                    creality: Object.freeze({ ...timing.creality }),
                  })
                : Object.freeze({ ...timing }),
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
  /** Spoolman mirror updates re-emit the snapshot; unavailable inventory is omitted. */
  function setInventory(value: SpoolmanSnapshot) {
    if (closed) return
    let summary: SpoolSummaryState | null = null
    try {
      summary = summarizeSpoolman(value)
    } catch {
      // Malformed mirror data must never disturb printer status.
    }
    spoolState = summary ? { value: summary, receivedMono: clock() } : undefined
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
        timer = setTimeout(
          update,
          Math.max(
            1,
            Math.min(value.wakeAt, value.value.validUntilMonoMs) - now,
          ),
        )
        runSynchronous(() => options.onComplete(value.value))
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
  return { observe, invalidate, setInventory, open, close }
}
