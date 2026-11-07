import { createHash } from 'node:crypto'
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
  printState: z.enum(['printing', 'paused', 'idle', 'error', 'unknown']),
  readyObservedMono: mono,
  printStateObservedMono: mono,
  receivedMono: mono,
})
export type ControlObservation = Readonly<z.infer<typeof Observation>>
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
  pauseOnce(input: {
    binding: PrinterBinding
    beforeSend(): boolean
    signal: AbortSignal
  }): Promise<PauseRpcResult>
  waitForPaused(input: {
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
  | { kind: 'rejected'; reason: PauseDispatchReason }
  | {
      kind: 'not-sent' | 'applied' | 'outcome-unknown'
      cmdId: string
      reason: PauseDispatchReason
    }
type Sample = { wall: number; mono: number }

/** Internal library only. No runtime, printer driver, issuer, control transport or human confirmation is supplied. */
export function createPauseDispatcher(config: {
  authority: Omit<Parameters<typeof createPauseCapabilityVerifier>[0], 'clock'>
  clock: PauseAuthorityClock
  journal: CommandJournalHandle
  driver: PreparedPauseDriver
  resultTimeoutMs?: number
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
  const journal = config.journal
  const driver = Object.freeze({
    prepare: config.driver.prepare.bind(config.driver),
    closeAttempt: config.driver.closeAttempt.bind(config.driver),
    pauseOnce: config.driver.pauseOnce.bind(config.driver),
    waitForPaused: config.driver.waitForPaused.bind(config.driver),
  })
  let closed = false,
    clockBroken = false
  let previous: Sample | undefined, baseline: Sample | undefined
  const observations = new WeakMap<PrinterBinding, ControlObservation>()
  const observationVersions = new WeakMap<PrinterBinding, object>()
  const observationGenerations = new WeakMap<PrinterBinding, number>()
  const slots = new Set<string>()
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
        (previous && (now.wall < previous.wall || now.mono < previous.mono)) ||
        (baseline &&
          Math.abs(now.wall - baseline.wall - (now.mono - baseline.mono)) >
            1000)
      )
        throw new Error('Invalid local clock')
      previous = now
      baseline ??= now
      return now
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
  return Object.freeze({
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
      let command: SignedCommandV2
      try {
        command = decodeCommandV2(input.wire)
      } catch {
        return Promise.resolve({ kind: 'rejected', reason: 'invalid-command' })
      }
      const candidateMapping = readPrinterBinding(printerBinding)
      if (!candidateMapping)
        return Promise.resolve({ kind: 'rejected', reason: 'scope' })
      const mapping = candidateMapping
      let observationVersion: object | undefined
      let generationInstalled = false
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
      let connectionGeneration: number | undefined
      let cursor: ObservationCursor | undefined
      let capability: PauseCapabilitySnapshot | undefined
      const commandDeadline =
        start.mono +
        Math.min(verifier.policy.commandMs, command.expires_at - start.wall)
      const resultDeadline = start.mono + resultTimeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      let resolveResult: (result: PauseDispatchResult) => void = () => {}
      const result = new Promise<PauseDispatchResult>((resolve) => {
        resolveResult = resolve
      })
      let finishDetails:
        | { journalReason: CommandJournalReason; observedWall?: number }
        | undefined
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
            }
          : { kind: 'rejected', reason }
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
      function postSendCurrent(): boolean {
        const observation = observations.get(printerBinding)
        return (
          !boundaryClosed &&
          !closed &&
          !signal?.aborted &&
          !terminal &&
          !contractBroken &&
          !clockBroken &&
          observationVersions.get(printerBinding) === observationVersion &&
          !!capability &&
          readPrinterBinding(printerBinding) === mapping &&
          verifier.inspectLifecycle(authorityHandle) &&
          !!observation &&
          observation.assignmentId === mapping.assignment_id &&
          observation.printerKey === mapping.printer_key &&
          observation.connectionGeneration === connectionGeneration
        )
      }
      function eligible(): ControlObservation | null {
        if (!capability) return null
        const now = sample()
        if (!now) return null
        const current = readObservation(printerBinding, capability, now)
        if (
          !current ||
          !current.ready ||
          current.printState !== 'printing' ||
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
        if (
          !finalObservation ||
          !finalObservation.ready ||
          finalObservation.printState !== 'printing' ||
          finalObservation.connectionGeneration !== connectionGeneration ||
          terminal
        )
          return false
        cursor = Object.freeze({
          connectionGeneration: finalObservation.connectionGeneration,
          sequence: finalObservation.sequence,
          sentMono: now.mono,
        })
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
            finalize('not-sent', 'state', 'guard-denied')
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
          const rpc = await driver.pauseOnce({
            binding: printerBinding,
            beforeSend,
            signal: controller.signal,
          })
          if (terminal) return
          if (!guardCalled || contractBroken) {
            finalize('outcome-unknown', 'driver-contract', 'driver-contract')
            return
          }
          if (!permitted || !cursor) {
            finalize('not-sent', 'guard-denied', 'guard-denied')
            return
          }
          if (!postSendCurrent()) {
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
          const paused = await driver.waitForPaused({
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
            observation.printState !== 'paused' ||
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
        } catch {
          if (!terminal)
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
}
