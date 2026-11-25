import { DriverRefusalError } from './driver-refusal.ts'
import { toolTemperatureRefusal } from './control-driver.ts'
import { ToolHeaters } from '../../../farm-protocol/src/state.ts'
import { authorityConfirmation } from '../auth/offline-authority.ts'
import {
  controlWithinLimits,
  type ControlLimits,
} from '../runtime/control-limits.ts'
import {
  speedModeAllowed,
  controlPrinterBusy,
  controlSourceState,
  controlRoleAllowed,
  controlTargetState,
  ControlResultCode,
  ToolIndex,
  ToolTemperatureArgs,
  U1_CONTROL_RESULT_TIMEOUT_MS,
  isU1PhysicalControl,
  type ControlAction,
  type ExtendedControlAction,
  type SpeedMode,
} from '../../../farm-protocol/src/control-actions.ts'
import { createHash } from 'node:crypto'
import {
  macroParamsAllowed,
  type MacroParamMap,
} from '../moonraker/control-macros.ts'
import { z } from 'zod'
import {
  decodeCommandV2,
  encodeCommandV2,
  verifyCommandV2,
  type SignedCommandV2,
} from '../../../farm-protocol/src/command-v2.ts'
import {
  createPauseCapabilityVerifier,
  type PauseAuthorityClock,
  type PauseCapabilitySnapshot,
} from '../auth/pause-capability.ts'
import { readPrinterBinding, type PrinterBinding } from './printer-binding.ts'
import {
  claimCommand,
  markWriteStarted,
  finishCommand,
  finishCommandAt,
  clearUncertainHolds,
  hasReadyReleasableHold,
  releaseHoldsOnReady,
  type CommandJournalHandle,
  type CommandClaimHandle,
  type CommandJournalReason,
} from './command-journal.ts'

const RpcAcknowledgement = z.strictObject({ acknowledged: z.boolean() })
const mono = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Observation = z.strictObject({
  assignmentId: z.string().uuid(),
  printerKey: z.string().min(1).max(128),
  connectionGeneration: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ready: z.boolean(),
  printState: z.enum([
    'printing',
    'paused',
    'idle',
    'cancelled',
    'error',
    'unknown',
  ]),
  readyObservedMono: mono,
  printStateObservedMono: mono,
  receivedMono: mono,
  toolHeaters: ToolHeaters.optional(),
  effect: z
    .discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('file'),
        filename: z.string(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('temperature'),
        heater: z.enum(['extruder', 'bed', 'chamber']),
        target_c: z.number().finite(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('tool-temperature'),
        tool: ToolIndex,
        target_c: z.number().int().nonnegative(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('motion'),
        action: z.enum(['home', 'jog']),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('gcode'),
        line: z.string(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('fan'),
        fan: z.enum(['part', 'aux', 'chamber']),
        percent: z.number().finite().min(0).max(100),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('excluded-object'),
        name: z.string(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('light'),
        on: z.boolean(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('camera-stream'),
        on: z.boolean(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('filament-slot'),
        tray: z.number().int().min(0).max(3),
        material: z.string().max(16),
        color: z.string().max(7),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('filament'),
        tray: z.number().int().min(0).max(15).nullable(),
        observedMono: mono,
      }),
      z.strictObject({
        kind: z.literal('speed'),
        level: z.enum(['silent', 'standard', 'sport', 'ludicrous']),
        observedMono: mono,
      }),
    ])
    .optional(),
})
export type ControlObservation = Readonly<z.infer<typeof Observation>>
export function controlEffectMatches(
  action: ExtendedControlAction,
  args: Record<string, unknown>,
  observation: ControlObservation,
  sentMono: number,
): boolean {
  if (action === 'pause' || action === 'resume' || action === 'cancel')
    return observation.printState === controlTargetState(action)
  const effect = observation.effect
  if (
    !effect ||
    effect.observedMono <= sentMono ||
    effect.observedMono > observation.receivedMono
  )
    return false
  switch (action) {
    case 'start_print':
      return (
        effect.kind === 'file' &&
        effect.filename === args.file &&
        (observation.printState === 'printing' ||
          observation.printState === 'paused')
      )
    // The driver wrapper only returns an effect naming the file it uploaded.
    case 'start_library_print':
      return (
        effect.kind === 'file' &&
        (observation.printState === 'printing' ||
          observation.printState === 'paused')
      )
    case 'set_tool_temperature':
      return (
        effect.kind === 'tool-temperature' &&
        effect.tool === args.tool &&
        effect.target_c === args.target_c
      )
    case 'set_temperature':
      return (
        effect.kind === 'temperature' &&
        effect.heater === args.heater &&
        effect.target_c === args.target_c
      )
    case 'home':
    case 'jog':
      return effect.kind === 'motion' && effect.action === action
    case 'gcode':
      return (
        effect.kind === 'gcode' &&
        typeof args.line === 'string' &&
        effect.line === args.line.trim()
      )
    case 'set_fan':
      return (
        effect.kind === 'fan' &&
        effect.fan === args.fan &&
        typeof args.percent === 'number' &&
        Math.abs(effect.percent - args.percent) <= 1
      )
    case 'exclude_object':
      return effect.kind === 'excluded-object' && effect.name === args.name
    case 'set_light':
      return effect.kind === 'light' && effect.on === args.on
    case 'set_camera_stream':
      return effect.kind === 'camera-stream' && effect.on === args.on
    case 'set_filament_slot':
      return (
        effect.kind === 'filament-slot' &&
        effect.tray === args.tray &&
        effect.material === args.material &&
        effect.color === args.color
      )
    case 'load_filament':
      return effect.kind === 'filament' && effect.tray === args.tray
    case 'unload_filament':
      return effect.kind === 'filament' && effect.tray === null
    case 'set_speed':
      return effect.kind === 'speed' && effect.level === args.level
    default:
      return false
  }
}
export type ObservationCursor = Readonly<{
  connectionGeneration: number
  sequence: number
  sentMono: number
}>
export type PauseRpcResult = { acknowledged: boolean }
/**
 * Trusted fixed-operation driver boundary, not a network implementation. A true beforeSend
 * must be followed by exactly one pause send on that same synchronous stack: no await,
 * reconnect, queue or retry. A false/throwing guard forbids every send for this attempt.
 */
export interface PauseDriver {
  execute?(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
    input: {
      binding: PrinterBinding
      beforeSend(): boolean
      /** Connector-only filename from the validated resin replay path. */
      verifiedResinFilename?: string
      transportId?: string
      stillAuthorized?(): boolean
      signal: AbortSignal
    },
  ): Promise<PauseRpcResult>
  macros?(binding: PrinterBinding): readonly string[] | undefined
  macroParams?(binding: PrinterBinding): MacroParamMap | undefined
  startUnavailableMessage?(binding: PrinterBinding): string | undefined
  controls?(binding: PrinterBinding): readonly ExtendedControlAction[]
  allowsExtendedResult?(binding: PrinterBinding): boolean
  /**
   * Bounded time the driver's own steps may take after the write, when that
   * exceeds the default result deadline. Counted from the write, so waits
   * before it never make a sent command uncertain. Never retried either way.
   */
  resultWindowMs?(
    binding: PrinterBinding,
    action: ExtendedControlAction,
  ): number | undefined
  speedModes?(binding: PrinterBinding): readonly SpeedMode[] | undefined
  pauseOnce(input: {
    args?: Record<string, unknown>
    action?: ControlAction
    binding: PrinterBinding
    beforeSend(): boolean
    signal: AbortSignal
  }): Promise<PauseRpcResult>
  waitForPaused(input: {
    args?: Record<string, unknown>
    action?: ControlAction
    binding: PrinterBinding
    after: ObservationCursor
    signal: AbortSignal
  }): Promise<ControlObservation | null>
}
export interface PreparedPauseDriver extends PauseDriver {
  prepare(input: {
    binding: PrinterBinding
    signal: AbortSignal
  }): Promise<{ connectionGeneration: number }>
  closeAttempt(binding: PrinterBinding): Promise<void>
}
export type PauseDispatchReason =
  | 'unsupported-action'
  | 'invalid-command'
  | 'invalid-authority'
  | 'scope'
  | 'signature'
  | 'expired'
  | 'state'
  | 'busy'
  | 'replay'
  | 'storage'
  | 'revoked'
  | 'closed'
  | 'aborted'
  | 'deadline'
  | 'driver-contract'
  | 'rpc-unknown'
  | 'state-unconfirmed'
  | 'guard-denied'
  | 'applied'
export type PauseDispatchResult =
  | { kind: 'rejected'; reason: PauseDispatchReason; message?: string }
  | {
      kind: 'not-sent' | 'applied' | 'outcome-unknown'
      cmdId: string
      reason: PauseDispatchReason
      /** Advisory driver detail. Present only when a driver reported one. */
      code?: ControlResultCode
      message?: string
    }
type Sample = { wall: number; mono: number }

/** A driver's window may only widen the default, and never past the U1 ceiling. */
function boundedResultWindow(ms: number | undefined): number | undefined {
  return ms !== undefined &&
    Number.isFinite(ms) &&
    ms > 5000 &&
    ms <= U1_CONTROL_RESULT_TIMEOUT_MS
    ? Math.ceil(ms)
    : undefined
}

/** Internal library only. No runtime, printer driver, issuer, control transport or human confirmation is supplied. */
export function createPauseDispatcher(config: {
  authority: Omit<Parameters<typeof createPauseCapabilityVerifier>[0], 'clock'>
  clock: PauseAuthorityClock
  journal: CommandJournalHandle
  driver: PreparedPauseDriver
  controlLimits?: ControlLimits
  resultTimeoutMs?: number
  /** True refuses every command with `storage` before the journal is touched. */
  storageDegraded?: () => boolean
}) {
  const verifier = createPauseCapabilityVerifier({
    ...config.authority,
    clock: config.clock,
  })
  const resultTimeoutMs = config.resultTimeoutMs ?? 5000
  if (
    !Number.isSafeInteger(resultTimeoutMs) ||
    resultTimeoutMs <= 0 ||
    resultTimeoutMs > 5000
  )
    throw new Error('Invalid pause result deadline')
  const wallNow = config.clock.wallNow.bind(config.clock),
    monotonicNow = config.clock.monotonicNow.bind(config.clock)
  const freshness = config.authority.freshness
  const journal = config.journal
  const driver = Object.freeze({
    execute: config.driver.execute?.bind(config.driver),
    controls: config.driver.controls?.bind(config.driver),
    startUnavailableMessage: config.driver.startUnavailableMessage?.bind(
      config.driver,
    ),
    allowsExtendedResult: config.driver.allowsExtendedResult?.bind(
      config.driver,
    ),
    resultWindowMs: config.driver.resultWindowMs?.bind(config.driver),
    speedModes: config.driver.speedModes?.bind(config.driver),
    macros: config.driver.macros?.bind(config.driver),
    macroParams: config.driver.macroParams?.bind(config.driver),
    prepare: config.driver.prepare.bind(config.driver),
    closeAttempt: config.driver.closeAttempt.bind(config.driver),
    pauseOnce: config.driver.pauseOnce.bind(config.driver),
    waitForPaused: config.driver.waitForPaused.bind(config.driver),
  })
  let closed = false,
    clockBroken = false
  let skewBroken = false
  let confirmation: Sample | null | undefined
  let previous: Sample | undefined, baseline: Sample | undefined
  const observations = new WeakMap<PrinterBinding, ControlObservation>()
  const observationVersions = new WeakMap<PrinterBinding, object>()
  const observationGenerations = new WeakMap<PrinterBinding, number>()
  const slots = new Set<string>()
  /** Slots held only by a pre-claim readiness read: emergency stop takes them. */
  const probes = new Map<string, () => Promise<void>>()
  const stopAttempts = new Set<() => void>()
  const pending = new Set<Promise<void>>()
  let resolveSettled: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  function maybeSettled() {
    if (closed && pending.size === 0) resolveSettled()
  }
  function sample(): Sample | null {
    if (clockBroken) return null
    try {
      const now = { wall: wallNow(), mono: monotonicNow() }
      if (
        !Number.isSafeInteger(now.wall) ||
        now.wall < 0 ||
        !Number.isFinite(now.mono) ||
        now.mono < 0 ||
        now.mono > Number.MAX_SAFE_INTEGER - 30_000 ||
        (previous && (now.wall < previous.wall || now.mono < previous.mono))
      )
        throw new Error('Invalid local clock')
      const confirmed = authorityConfirmation(freshness)
      if (confirmed && confirmed !== confirmation) {
        if (
          !Number.isSafeInteger(confirmed.wall) ||
          confirmed.wall < 0 ||
          !Number.isFinite(confirmed.mono) ||
          confirmed.mono < 0 ||
          confirmed.wall > now.wall ||
          confirmed.mono > now.mono ||
          (previous &&
            (confirmed.wall < previous.wall || confirmed.mono < previous.mono))
        )
          throw new Error('Invalid confirmation clock')
        confirmation = confirmed
        baseline = confirmed
        skewBroken = false
      }
      previous = now
      baseline ??= now
      if (
        Math.abs(now.wall - baseline.wall - (now.mono - baseline.mono)) > 1000
      )
        skewBroken = true
      return skewBroken ? null : now
    } catch {
      clockBroken = true
      return null
    }
  }
  function readObservation(
    binding: PrinterBinding,
    capability: PauseCapabilitySnapshot,
    now: Sample,
  ): ControlObservation | null {
    try {
      const observation = observations.get(binding)
      if (!observation) return null
      if (
        observation.assignmentId !== capability.assignment_id ||
        observation.printerKey !== capability.printer_key ||
        observation.receivedMono > now.mono ||
        observation.readyObservedMono > observation.receivedMono ||
        observation.printStateObservedMono > observation.receivedMono ||
        now.mono - observation.readyObservedMono >
          verifier.policy.freshStateMs ||
        now.mono - observation.printStateObservedMono >
          verifier.policy.freshStateMs
      )
        return null
      return observation
    } catch {
      return null
    }
  }
  const dispatcher = Object.freeze({
    /** Trusted local observation publisher only; never accept this input from a command or server. */
    observe(binding: PrinterBinding, input: unknown): boolean {
      observations.delete(binding)
      function invalidate() {
        observationVersions.set(binding, Object.freeze({}))
        return false
      }
      if (closed || input === null) return invalidate()
      const mapping = readPrinterBinding(binding)
      const parsed = Observation.safeParse(input)
      if (
        !mapping ||
        !parsed.success ||
        parsed.data.assignmentId !== mapping.assignment_id ||
        parsed.data.printerKey !== mapping.printer_key
      )
        return invalidate()
      const generation = observationGenerations.get(binding)
      if (
        generation !== undefined &&
        parsed.data.connectionGeneration < generation
      )
        return invalidate()
      if (
        generation !== undefined &&
        parsed.data.connectionGeneration !== generation
      )
        invalidate()
      observationGenerations.set(binding, parsed.data.connectionGeneration)
      observations.set(binding, Object.freeze(parsed.data))
      return true
    },
    beginAdmission(input: Parameters<typeof verifier.beginAdmission>[0]) {
      if (closed) throw new Error('Pause dispatcher is closed')
      return verifier.beginAdmission(input)
    },
    createPeer: verifier.createPeer,
    revoke: verifier.revoke,
    async admit(
      ...args: Parameters<typeof verifier.admit>
    ): ReturnType<typeof verifier.admit> {
      if (closed) return { ok: false, reason: 'expired-or-inactive' }
      const result = await verifier.admit(...args)
      if (closed) return { ok: false, reason: 'expired-or-inactive' }
      return result
    },
    dispatch(input: {
      wire: unknown
      capability: unknown
      printerBinding: PrinterBinding
      signal?: AbortSignal
    }): Promise<PauseDispatchResult> {
      const { capability: authorityHandle, printerBinding, signal } = input
      if (closed) return Promise.resolve({ kind: 'rejected', reason: 'closed' })
      if (signal?.aborted)
        return Promise.resolve({ kind: 'rejected', reason: 'aborted' })
      // Fail closed: a gate that throws counts as degraded storage.
      let degraded = true
      try {
        degraded = config.storageDegraded?.() ?? false
      } catch {
        // Keeps the refusal.
      }
      if (degraded)
        return Promise.resolve({ kind: 'rejected', reason: 'storage' })
      let command: SignedCommandV2
      try {
        command = decodeCommandV2(input.wire)
      } catch {
        return Promise.resolve({ kind: 'rejected', reason: 'invalid-command' })
      }
      if (
        !controlWithinLimits(command.action, command.args, config.controlLimits)
      )
        return Promise.resolve({ kind: 'rejected', reason: 'invalid-command' })
      const toolArgs =
        command.action === 'set_tool_temperature'
          ? ToolTemperatureArgs.parse(command.args)
          : undefined
      const candidateMapping = readPrinterBinding(printerBinding)
      if (!candidateMapping)
        return Promise.resolve({ kind: 'rejected', reason: 'scope' })
      const mapping = candidateMapping
      let observationVersion: object | undefined
      let generationInstalled = false
      const preempt = probes.get(mapping.assignment_id)
      if (preempt && command.action === 'emergency_stop')
        return preempt().then(() => dispatcher.dispatch(input))
      if (slots.size >= 8 || slots.has(mapping.assignment_id))
        return Promise.resolve({ kind: 'rejected', reason: 'busy' })
      slots.add(mapping.assignment_id) // No wait list. Retained until underlying asynchronous work actually settles.
      let settleWork: () => void = () => {}
      const work = new Promise<void>((resolve) => {
        settleWork = resolve
      })
      pending.add(work)
      void work.then(() => {
        pending.delete(work)
        maybeSettled()
      })
      const start = sample()
      if (!start) {
        slots.delete(mapping.assignment_id)
        settleWork()
        return Promise.resolve({ kind: 'rejected', reason: 'expired' })
      }
      const controller = new AbortController()
      let receipt: CommandClaimHandle | undefined
      let claiming = false
      let claimInterrupted: 'closed' | 'aborted' | 'deadline' | undefined
      let terminal: PauseDispatchResult | undefined
      let boundaryClosed = false,
        guardCalled = false,
        permitted = false,
        contractBroken = false
      let driverCalled = false
      let slotFreed: () => void = () => {}
      let connectionGeneration: number | undefined
      let cursor: ObservationCursor | undefined
      let capability: PauseCapabilitySnapshot | undefined
      const commandDeadline =
        start.mono +
        Math.min(verifier.policy.commandMs, command.expires_at - start.wall)
      let resultDeadline = start.mono + resultTimeoutMs
      let extendedResultMs: number | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let resolveResult: (result: PauseDispatchResult) => void = () => {}
      const result = new Promise<PauseDispatchResult>((resolve) => {
        resolveResult = resolve
      })
      let finishDetails:
        | { journalReason: CommandJournalReason; observedWall?: number }
        | undefined
      let resultCode: ControlResultCode | undefined
      let cleaned = false
      function cleanup() {
        if (cleaned) return
        cleaned = true
        controller.abort()
        stopAttempts.delete(onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      function finalize(
        kind: PauseDispatchResult['kind'],
        reason: PauseDispatchReason,
        journalReason: CommandJournalReason,
        observedWall?: number,
        message?: string,
      ): PauseDispatchResult {
        if (terminal) return terminal
        if (kind === 'applied' && (!cleaned || observedWall === undefined)) {
          kind = 'outcome-unknown'
          reason = 'state-unconfirmed'
          journalReason = 'state-unconfirmed'
        }
        boundaryClosed = true
        // Latch before abort listeners can synchronously reenter close/finalization.
        terminal = receipt
          ? {
              kind: kind === 'rejected' ? 'not-sent' : kind,
              cmdId: command.cmd_id,
              reason,
              ...(message ? { message } : {}),
              ...(resultCode && kind !== 'applied' ? { code: resultCode } : {}),
            }
          : { kind: 'rejected', reason, ...(message ? { message } : {}) }
        cleanup()
        finishDetails =
          observedWall === undefined
            ? { journalReason }
            : { journalReason, observedWall }
        return terminal
      }
      function interrupted(reason: 'closed' | 'aborted' | 'deadline') {
        if (claiming) {
          claimInterrupted ??= reason
          controller.abort()
          return
        }
        if (terminal) {
          if (receipt && permitted && terminal.kind === 'applied') {
            terminal = {
              kind: 'outcome-unknown',
              cmdId: command.cmd_id,
              reason,
            }
            finishDetails = {
              journalReason: reason === 'closed' ? 'dispatcher-closed' : reason,
            }
          }
          resolveResult(terminal)
          return terminal
        }
        const interruptedResult = finalize(
          permitted || contractBroken
            ? 'outcome-unknown'
            : receipt
              ? 'not-sent'
              : 'rejected',
          reason,
          reason === 'closed' ? 'dispatcher-closed' : reason,
        )
        resolveResult(interruptedResult)
        return interruptedResult
      }
      function onClose() {
        interrupted('closed')
      }
      function onAbort() {
        interrupted('aborted')
      }
      function liveAt(now: Sample | null): PauseDispatchReason | null {
        if (boundaryClosed || closed) return 'closed'
        if (
          generationInstalled &&
          observationVersions.get(printerBinding) !== observationVersion
        )
          return 'state'
        if (controller.signal.aborted || signal?.aborted) return 'aborted'
        if (
          !now ||
          now.mono >= commandDeadline ||
          now.wall >= command.expires_at ||
          command.issued_at > now.wall
        )
          return 'expired'
        const decision = verifier.inspectAt(authorityHandle, now.wall, now.mono)
        if (!decision.ok) return 'invalid-authority'
        const cap = decision.capability
        if (
          !cap.actions.includes(command.action) ||
          !controlRoleAllowed(cap.role, command.action)
        )
          return 'scope'
        if (
          command.action === 'set_speed' &&
          !speedModeAllowed(
            driver.speedModes?.(printerBinding),
            command.args.level,
          )
        )
          return 'unsupported-action'
        if (
          command.action === 'run_macro' &&
          (typeof command.args.name !== 'string' ||
            !driver.macros?.(printerBinding)?.includes(command.args.name) ||
            !macroParamsAllowed(
              driver.macroParams?.(printerBinding),
              command.args.name,
              command.args.params,
            ))
        )
          return 'unsupported-action'
        if (
          command.capability_id !== cap.capability_id ||
          command.transport_id !== cap.transport_id ||
          command.assignment_id !== cap.assignment_id ||
          command.farm_id !== cap.farm_id ||
          command.agent_id !== cap.agent_id ||
          command.account_id !== cap.account_id ||
          command.key_id !== cap.key_id ||
          mapping.assignment_id !== cap.assignment_id ||
          mapping.farm_id !== cap.farm_id ||
          mapping.agent_id !== cap.agent_id ||
          mapping.printer_key !== cap.printer_key ||
          readPrinterBinding(printerBinding) !== mapping
        )
          return 'scope'
        if (
          command.issued_at < cap.issued_at ||
          command.expires_at > cap.expires_at ||
          command.expires_at - command.issued_at > decision.policy.commandMs
        )
          return 'expired'
        capability = cap
        return null
      }
      function live(): PauseDispatchReason | null {
        return liveAt(sample())
      }
      // Pure local state only. Time-only authority expiry does not prevent a readonly result audit.
      function postSendCurrent(allowRestartDisconnect = false): boolean {
        const observation = observations.get(printerBinding)
        return (
          !boundaryClosed &&
          !closed &&
          !signal?.aborted &&
          !terminal &&
          !contractBroken &&
          !clockBroken &&
          !skewBroken &&
          !!capability &&
          readPrinterBinding(printerBinding) === mapping &&
          verifier.inspectLifecycle(authorityHandle) &&
          (allowRestartDisconnect ||
            (observationVersions.get(printerBinding) === observationVersion &&
              !!observation &&
              observation.assignmentId === mapping.assignment_id &&
              observation.printerKey === mapping.printer_key &&
              observation.connectionGeneration === connectionGeneration))
        )
      }
      /** Set by eligible() when the shared idle-only rule refused the command. */
      let refusedBusy = false
      function eligible(): ControlObservation | null {
        if (!capability) return null
        const now = sample()
        if (!now) return null
        const current = readObservation(printerBinding, capability, now)
        if (toolArgs) resultCode = toolTemperatureRefusal(current, toolArgs)
        refusedBusy =
          !!current &&
          current.ready &&
          controlPrinterBusy(command.action, current.printState)
        if (
          (toolArgs && resultCode) ||
          !current ||
          !current.ready ||
          !controlSourceState(command.action, current.printState) ||
          (connectionGeneration !== undefined &&
            current.connectionGeneration !== connectionGeneration)
        )
          return null
        return current
      }
      function beforeSend(): boolean {
        if (guardCalled) {
          contractBroken = true
          return false
        }
        guardCalled = true
        if (boundaryClosed || !receipt) return false
        let marked = false
        try {
          marked = markWriteStarted(journal, receipt)
        } catch {
          /* zero writes */
        }
        if (!marked) return false
        // Clock callbacks are the final external calls. Every mutable authority/state check follows them.
        const now = sample()
        if (liveAt(now) || !now || !capability || now.mono >= resultDeadline)
          return false
        const finalObservation = readObservation(
          printerBinding,
          capability,
          now,
        )
        if (toolArgs)
          resultCode = toolTemperatureRefusal(finalObservation, toolArgs)
        if (
          (toolArgs && resultCode) ||
          !finalObservation ||
          !finalObservation.ready ||
          !controlSourceState(command.action, finalObservation.printState) ||
          finalObservation.connectionGeneration !== connectionGeneration ||
          terminal
        )
          return false
        cursor = Object.freeze({
          connectionGeneration: finalObservation.connectionGeneration,
          sequence: finalObservation.sequence,
          sentMono: now.mono,
        })
        // Extend only the result wait, after every signed write check passed.
        if (extendedResultMs !== undefined) {
          resultDeadline = now.mono + extendedResultMs
          clearTimeout(timer)
          timer = setTimeout(() => interrupted('deadline'), extendedResultMs)
        }
        permitted = true
        return true // The driver must send immediately on this stack, with no intervening await.
      }
      stopAttempts.add(onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      const timerSample = sample()
      timer = setTimeout(
        () => interrupted('deadline'),
        Math.max(
          0,
          Math.min(resultDeadline, commandDeadline) -
            (timerSample?.mono ?? resultDeadline),
        ),
      )
      /**
       * One read-only look at the printer before the claim. A ready printer is
       * the evidence that releases a restart hold; without it the timed release
       * still applies. Nothing is sent.
       */
      async function releaseOnReadyEvidence(): Promise<void> {
        const hold = {
          assignmentId: mapping.assignment_id,
          farmId: mapping.farm_id,
          printerKey: mapping.printer_key,
        }
        if (!hasReadyReleasableHold(journal, hold)) return
        const preempted = new AbortController()
        const freed = new Promise<void>((resolve) => {
          slotFreed = resolve
        })
        probes.set(mapping.assignment_id, () => {
          preempted.abort()
          return freed
        })
        observations.delete(printerBinding)
        observationVersions.set(printerBinding, Object.freeze({}))
        try {
          const prepared = await driver.prepare({
            binding: printerBinding,
            signal: AbortSignal.any([controller.signal, preempted.signal]),
          })
          const now = sample()
          const seen =
            now && capability
              ? readObservation(printerBinding, capability, now)
              : null
          if (
            !terminal &&
            seen?.ready &&
            seen.printState !== 'unknown' &&
            seen.connectionGeneration === prepared.connectionGeneration
          )
            releaseHoldsOnReady(journal, hold)
        } catch {
          // No evidence: the journal decides with the hold in place.
        } finally {
          try {
            await driver.closeAttempt(printerBinding)
          } catch {
            // The slot stays held: the waiting stop is refused as busy.
            probes.delete(mapping.assignment_id)
            slotFreed()
            await new Promise<void>(() => {})
          }
          probes.delete(mapping.assignment_id)
          // Yield to the waiting emergency stop without claiming anything.
          if (preempted.signal.aborted)
            finalize('rejected', 'busy', 'guard-denied')
        }
      }
      // An unresolved crypto/driver promise keeps its slot even after the bounded result is returned.
      void (async () => {
        try {
          let denial = live()
          if (denial || !capability) {
            finalize('rejected', denial ?? 'invalid-authority', 'guard-denied')
            return
          }
          if (
            !(await verifyCommandV2(command, capability.browser_public_key))
          ) {
            finalize('rejected', 'signature', 'guard-denied')
            return
          }
          if (terminal) return
          denial = live()
          if (denial) {
            finalize('rejected', denial, 'guard-denied')
            return
          }
          // `clear_hold` is a Connector journal write, whatever the driver.
          if (
            command.action !== 'clear_hold' &&
            ((!driver.execute &&
              !['pause', 'resume', 'cancel'].includes(command.action)) ||
              !(driver.controls?.(printerBinding) ?? ['pause']).includes(
                command.action,
              ))
          ) {
            finalize(
              'rejected',
              'unsupported-action',
              'guard-denied',
              undefined,
              command.action === 'start_print' ||
                command.action === 'start_library_print'
                ? driver.startUnavailableMessage?.(printerBinding)
                : undefined,
            )
            return
          }
          extendedResultMs =
            isU1PhysicalControl(command.action, command.args) &&
            driver.allowsExtendedResult?.(printerBinding) === true
              ? U1_CONTROL_RESULT_TIMEOUT_MS
              : boundedResultWindow(
                  driver.resultWindowMs?.(printerBinding, command.action),
                )
          if (
            command.action !== 'emergency_stop' &&
            command.action !== 'clear_hold'
          ) {
            await releaseOnReadyEvidence()
            if (terminal) return
            denial = live()
            if (denial) {
              finalize('rejected', denial, 'guard-denied')
              return
            }
          }
          let claim: ReturnType<typeof claimCommand>
          try {
            claiming = true
            claim = claimCommand(journal, {
              command,
              printerKey: mapping.printer_key,
              wireSha256: createHash('sha256')
                .update(encodeCommandV2(command))
                .digest('hex'),
            })
          } catch {
            claiming = false
            if (claimInterrupted) interrupted(claimInterrupted)
            else finalize('rejected', 'storage', 'storage')
            return
          }
          claiming = false
          if (!claim.ok) {
            if (claimInterrupted) {
              interrupted(claimInterrupted)
              return
            }
            finalize(
              'rejected',
              claim.reason === 'replay'
                ? 'replay'
                : claim.reason === 'assignment-busy'
                  ? 'busy'
                  : 'storage',
              'storage',
            )
            return
          }
          receipt = claim.receipt
          if (claimInterrupted) {
            interrupted(claimInterrupted)
            return
          }
          denial = live()
          if (denial) {
            finalize('not-sent', denial, 'guard-denied')
            return
          }
          // No printer connection, observation or send: the printer may be in
          // any state, and the operator has checked it.
          if (command.action === 'clear_hold') {
            const marked = markWriteStarted(journal, receipt)
            denial = live()
            if (denial) {
              finalize('not-sent', denial, 'guard-denied')
              return
            }
            if (
              !marked ||
              !clearUncertainHolds(journal, receipt, capability.role)
            ) {
              finalize('not-sent', 'storage', 'storage')
              return
            }
            cleanup()
            const clearedAt = sample()
            if (!clearedAt) {
              finalize('outcome-unknown', 'storage', 'storage')
              return
            }
            finalize('applied', 'applied', 'applied', clearedAt.wall)
            return
          }
          observations.delete(printerBinding)
          observationVersions.set(printerBinding, Object.freeze({}))
          const prepared = await driver.prepare({
            binding: printerBinding,
            signal: controller.signal,
          })
          if (terminal) return
          connectionGeneration = prepared.connectionGeneration
          const current = eligible()
          if (
            !current ||
            current.connectionGeneration !== connectionGeneration
          ) {
            finalize('not-sent', refusedBusy ? 'busy' : 'state', 'guard-denied')
            return
          }
          observationVersion = observationVersions.get(printerBinding)
          generationInstalled = true
          denial = live()
          if (denial) {
            finalize('not-sent', denial, 'guard-denied')
            return
          }
          const beforeRpc = sample()
          if (!beforeRpc || beforeRpc.mono >= resultDeadline) {
            interrupted('deadline')
            return
          }
          driverCalled = true
          const rpc = await (driver.execute
            ? driver.execute(command.action, command.args, {
                binding: printerBinding,
                beforeSend,
                transportId: command.transport_id,
                stillAuthorized: () =>
                  !live() &&
                  (command.action !== 'start_library_print' || !!eligible()),
                signal: controller.signal,
              })
            : driver.pauseOnce({
                action: command.action as ControlAction,
                args: command.args,
                binding: printerBinding,
                beforeSend,
                signal: controller.signal,
              }))
          if (terminal) return
          if (!guardCalled || contractBroken) {
            finalize('outcome-unknown', 'driver-contract', 'driver-contract')
            return
          }
          if (!permitted || !cursor) {
            finalize('not-sent', 'guard-denied', 'guard-denied')
            return
          }
          if (
            !postSendCurrent(
              command.action === 'config_write' &&
                command.args.restart === true,
            )
          ) {
            finalize(
              'outcome-unknown',
              'state-unconfirmed',
              'state-unconfirmed',
            )
            return
          }
          const acknowledgement = RpcAcknowledgement.safeParse(rpc)
          if (terminal) return
          if (
            !acknowledgement.success ||
            acknowledgement.data.acknowledged !== true
          ) {
            finalize('outcome-unknown', 'rpc-unknown', 'rpc-unknown')
            return
          }
          const now = sample()
          if (!now || now.mono >= resultDeadline) {
            interrupted('deadline')
            return
          }
          // Local writes have no printer effect to observe.
          if (
            command.action === 'config_write' ||
            command.action === 'confirm_collection'
          ) {
            if (command.action === 'config_write') {
              cleanup()
              finalize('applied', 'applied', 'applied', now.wall)
              return
            }
            cleanup()
            const completedAt = sample()
            if (!completedAt || completedAt.mono >= resultDeadline) {
              finalize(
                'outcome-unknown',
                'state-unconfirmed',
                'state-unconfirmed',
              )
              return
            }
            finalize('applied', 'applied', 'applied', completedAt.wall)
            return
          }
          const paused = await driver.waitForPaused({
            action: command.action as ControlAction,
            args: command.args,
            binding: printerBinding,
            after: cursor,
            signal: controller.signal,
          })
          if (terminal) return
          // Copy untrusted driver properties and run abort listeners before the final clock sample.
          const parsed = Observation.safeParse(paused)
          cleanup()
          const observedAt = sample()
          if (
            !observedAt ||
            !postSendCurrent() ||
            observedAt.mono >= resultDeadline ||
            !parsed.success ||
            !capability
          ) {
            finalize(
              'outcome-unknown',
              'state-unconfirmed',
              'state-unconfirmed',
            )
            return
          }
          const observation = parsed.data
          if (
            !observation.ready ||
            (observation.effect !== undefined &&
              observedAt.mono - observation.effect.observedMono >
                verifier.policy.freshStateMs) ||
            !controlEffectMatches(
              command.action,
              command.args,
              observation,
              cursor.sentMono,
            ) ||
            observation.assignmentId !== mapping.assignment_id ||
            observation.printerKey !== mapping.printer_key ||
            observation.connectionGeneration !== cursor.connectionGeneration ||
            observation.sequence <= cursor.sequence ||
            observation.receivedMono <= cursor.sentMono ||
            observation.printStateObservedMono <= cursor.sentMono ||
            observation.receivedMono > observedAt.mono ||
            observation.readyObservedMono > observation.receivedMono ||
            observation.printStateObservedMono > observation.receivedMono ||
            observedAt.mono - observation.readyObservedMono >
              verifier.policy.freshStateMs ||
            observedAt.mono - observation.printStateObservedMono >
              verifier.policy.freshStateMs
          ) {
            finalize(
              'outcome-unknown',
              'state-unconfirmed',
              'state-unconfirmed',
            )
            return
          }
          finalize('applied', 'applied', 'applied', observedAt.wall)
        } catch (error) {
          const carried = ControlResultCode.safeParse(
            (error as { resultCode?: unknown } | null)?.resultCode,
          )
          if (carried.success) resultCode = carried.data
          // A typed refusal means the driver wrote nothing and says why.
          if (
            !terminal &&
            !permitted &&
            !guardCalled &&
            receipt &&
            error instanceof DriverRefusalError
          )
            finalize(
              'not-sent',
              error.refusal,
              'guard-denied',
              undefined,
              error.userMessage,
            )
          else if (!terminal)
            finalize(
              permitted || contractBroken || (driverCalled && !guardCalled)
                ? 'outcome-unknown'
                : receipt
                  ? 'not-sent'
                  : 'rejected',
              'rpc-unknown',
              'rpc-unknown',
            )
        } finally {
          boundaryClosed = true
          if (receipt) {
            try {
              await driver.closeAttempt(printerBinding)
            } catch {
              await new Promise<void>(() => {})
            }
            const details = finishDetails
            if (terminal && details) {
              const outcome =
                terminal.kind === 'applied'
                  ? 'applied'
                  : terminal.kind === 'outcome-unknown'
                    ? 'outcome-unknown'
                    : 'not-sent'
              let persisted = false
              try {
                persisted =
                  details.observedWall === undefined
                    ? finishCommand(
                        journal,
                        receipt,
                        outcome,
                        details.journalReason,
                      )
                    : finishCommandAt(
                        journal,
                        receipt,
                        outcome,
                        details.journalReason,
                        details.observedWall,
                      )
              } catch {
                /* conservative unknown */
              }
              if (!persisted)
                terminal = {
                  kind: 'outcome-unknown',
                  cmdId: command.cmd_id,
                  reason: 'storage',
                }
            }
          }
          slots.delete(mapping.assignment_id)
          slotFreed()
          clearTimeout(timer)
          if (terminal) resolveResult(terminal)
        }
      })().then(settleWork, settleWork)
      return result
    },
    get settled(): Promise<void> {
      return settled
    },
    close(): void {
      closed = true
      for (const stop of [...stopAttempts]) stop()
      maybeSettled()
    },
  })
  return dispatcher
}
