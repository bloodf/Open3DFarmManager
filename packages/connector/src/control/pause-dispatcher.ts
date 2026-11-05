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
  current(binding: PrinterBinding): ControlObservation | null
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
export type LocalRevocationScope = Readonly<{
  capabilityId: string
  accountId: string
  keyId: string
  farmId: string
  agentId: string
  assignmentId: string
  transportId: string
}>
export interface LocalRevocationSource {
  check(scope: LocalRevocationScope): boolean
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
  driver: PauseDriver
  localRevocations: LocalRevocationSource
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
    current: config.driver.current.bind(config.driver),
    pauseOnce: config.driver.pauseOnce.bind(config.driver),
    waitForPaused: config.driver.waitForPaused.bind(config.driver),
  })
  const checkRevocation = config.localRevocations.check.bind(
    config.localRevocations,
  )
  let closed = false,
    clockBroken = false
  let previous: Sample | undefined, baseline: Sample | undefined
  const slots = new Set<string>()
  const deniedHandles = new WeakSet<object>()
  const stopAttempts = new Set<() => void>()
  type PeerMetadata = { generation: number; currentGeneration(): number }
  const admissionPeers = new WeakMap<object, PeerMetadata>()
  const handlePeers = new WeakMap<object, PeerMetadata>()
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
      const observation = Object.freeze(
        Observation.parse(driver.current(binding)),
      )
      const sampledAfterRead = sample()
      if (!sampledAfterRead) return null
      now = sampledAfterRead
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
  function revoked(
    capability: PauseCapabilitySnapshot,
    handle: unknown,
  ): boolean {
    if (
      handle === null ||
      typeof handle !== 'object' ||
      deniedHandles.has(handle)
    )
      return true
    try {
      if (
        checkRevocation(
          Object.freeze({
            capabilityId: capability.capability_id,
            accountId: capability.account_id,
            keyId: capability.key_id,
            farmId: capability.farm_id,
            agentId: capability.agent_id,
            assignmentId: capability.assignment_id,
            transportId: capability.transport_id,
          }),
        ) === true
      )
        return false
    } catch {
      /* Local revocation storage failure denies authority. */
    }
    deniedHandles.add(handle) // An observed denial is terminal for this genuine handle.
    return true
  }
  return Object.freeze({
    beginAdmission(input: Parameters<typeof verifier.beginAdmission>[0]) {
      if (closed) throw new Error('Pause dispatcher is closed')
      const admitted = verifier.beginAdmission(input)
      admissionPeers.set(admitted.token, {
        generation: input.peerGeneration,
        currentGeneration: input.currentPeerGeneration.bind(input),
      })
      return admitted
    },
    async admit(
      ...args: Parameters<typeof verifier.admit>
    ): ReturnType<typeof verifier.admit> {
      if (closed) return { ok: false, reason: 'expired-or-inactive' }
      const [token] = args
      const peer =
        token !== null && typeof token === 'object'
          ? admissionPeers.get(token)
          : undefined
      if (token !== null && typeof token === 'object')
        admissionPeers.delete(token)
      const result = await verifier.admit(...args)
      if (closed) return { ok: false, reason: 'expired-or-inactive' }
      if (result.ok && peer) handlePeers.set(result.handle, peer)
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
      if (slots.size >= 8 || slots.has(mapping.assignment_id))
        return Promise.resolve({ kind: 'rejected', reason: 'busy' })
      slots.add(mapping.assignment_id) // No wait list. Retained until underlying asynchronous work actually settles.
      const start = sample()
      if (!start) {
        slots.delete(mapping.assignment_id)
        return Promise.resolve({ kind: 'rejected', reason: 'expired' })
      }
      const controller = new AbortController()
      let receipt: CommandClaimHandle | undefined
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
      function finalize(
        kind: PauseDispatchResult['kind'],
        reason: PauseDispatchReason,
        journalReason: CommandJournalReason,
      ): PauseDispatchResult {
        if (terminal) return terminal
        boundaryClosed = true
        // Latch before abort listeners can synchronously reenter close/finalization.
        terminal = receipt
          ? {
              kind: kind === 'rejected' ? 'not-sent' : kind,
              cmdId: command.cmd_id,
              reason,
            }
          : { kind: 'rejected', reason }
        controller.abort()
        clearTimeout(timer)
        stopAttempts.delete(onClose)
        signal?.removeEventListener('abort', onAbort)
        if (receipt) {
          const outcome =
            kind === 'applied'
              ? 'applied'
              : kind === 'outcome-unknown'
                ? 'outcome-unknown'
                : 'not-sent'
          let persisted = false
          try {
            persisted = finishCommand(journal, receipt, outcome, journalReason)
          } catch {
            /* conservative unknown */
          }
          if (!persisted) {
            kind = 'outcome-unknown'
            reason = 'storage'
          }
          terminal = {
            kind: kind === 'rejected' ? 'not-sent' : kind,
            cmdId: command.cmd_id,
            reason,
          }
        } else terminal = { kind: 'rejected', reason }
        resolveResult(terminal)
        return terminal
      }
      function interrupted(reason: 'closed' | 'aborted' | 'deadline') {
        return finalize(
          permitted || contractBroken
            ? 'outcome-unknown'
            : receipt
              ? 'not-sent'
              : 'rejected',
          reason,
          reason === 'closed' ? 'dispatcher-closed' : reason,
        )
      }
      function onClose() {
        interrupted('closed')
      }
      function onAbort() {
        interrupted('aborted')
      }
      function live(): PauseDispatchReason | null {
        if (boundaryClosed || closed) return 'closed'
        if (controller.signal.aborted || signal?.aborted) return 'aborted'
        const now = sample()
        if (
          !now ||
          now.mono >= commandDeadline ||
          now.wall >= command.expires_at ||
          command.issued_at > now.wall
        )
          return 'expired'
        const decision = verifier.inspect(authorityHandle)
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
        if (revoked(cap, authorityHandle)) return 'revoked'
        capability = cap
        return null
      }
      function postSendCurrent(): boolean {
        if (
          boundaryClosed ||
          closed ||
          controller.signal.aborted ||
          signal?.aborted ||
          !capability ||
          readPrinterBinding(printerBinding) !== mapping ||
          revoked(capability, authorityHandle)
        )
          return false
        if (authorityHandle === null || typeof authorityHandle !== 'object')
          return false
        const peer = handlePeers.get(authorityHandle)
        try {
          if (!peer || peer.currentGeneration() !== peer.generation) {
            deniedHandles.add(authorityHandle)
            return false
          }
          const observation = Observation.parse(driver.current(printerBinding))
          return (
            observation.assignmentId === mapping.assignment_id &&
            observation.printerKey === mapping.printer_key &&
            observation.connectionGeneration === connectionGeneration
          )
        } catch {
          return false
        }
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
        // Last durable commit precedes ALL final synchronous authority/state checks.
        if (live()) return false
        const current = eligible()
        if (!current || live()) return false
        const now = sample()
        if (
          !now ||
          !capability ||
          now.mono >= resultDeadline ||
          now.mono >= commandDeadline ||
          now.mono - current.readyObservedMono > verifier.policy.freshStateMs ||
          now.mono - current.printStateObservedMono >
            verifier.policy.freshStateMs ||
          now.wall >= command.expires_at ||
          now.wall >= capability.expires_at ||
          now.wall < capability.issued_at ||
          now.wall < command.issued_at ||
          boundaryClosed ||
          closed ||
          controller.signal.aborted ||
          signal?.aborted ||
          readPrinterBinding(printerBinding) !== mapping ||
          revoked(capability, authorityHandle)
        )
          return false
        cursor = Object.freeze({
          connectionGeneration: current.connectionGeneration,
          sequence: current.sequence,
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
        Math.max(0, resultDeadline - (timerSample?.mono ?? resultDeadline)),
      )
      // An unresolved crypto/driver promise keeps its slot even after the bounded result is returned.
      void (async () => {
        try {
          let denial = live()
          if (denial || !capability) {
            finalize('rejected', denial ?? 'invalid-authority', 'guard-denied')
            return
          }
          const prepared = eligible()
          if (!prepared) {
            finalize('rejected', 'state', 'guard-denied')
            return
          }
          connectionGeneration = prepared.connectionGeneration
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
          const current = eligible()
          if (!current) {
            finalize('rejected', 'state', 'guard-denied')
            return
          }
          connectionGeneration = current.connectionGeneration
          let claim: ReturnType<typeof claimCommand>
          try {
            claim = claimCommand(journal, {
              command,
              printerKey: mapping.printer_key,
              wireSha256: createHash('sha256')
                .update(encodeCommandV2(command))
                .digest('hex'),
            })
          } catch {
            finalize('rejected', 'storage', 'storage')
            return
          }
          if (!claim.ok) {
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
          denial = live()
          if (denial || !eligible()) {
            finalize('not-sent', denial ?? 'state', 'guard-denied')
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
          // Observation can finish after authorization expires; it never permits another write.
          if (!postSendCurrent()) {
            finalize(
              'outcome-unknown',
              'state-unconfirmed',
              'state-unconfirmed',
            )
            return
          }
          const observedAt = sample()
          const parsed = Observation.safeParse(paused)
          if (
            !observedAt ||
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
          finalize('applied', 'applied', 'applied')
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
          slots.delete(mapping.assignment_id)
        }
      })()
      return result
    },
    close(): void {
      closed = true
      for (const stop of [...stopAttempts]) stop()
    },
  })
}
