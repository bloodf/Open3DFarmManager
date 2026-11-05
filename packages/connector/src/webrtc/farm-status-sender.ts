import {
  immutableAdmission,
  runSynchronous,
  snapshotAssignmentRefs,
  validatedStatusMessage,
  type AssignmentRef,
  type VerifiedRtcAdmission,
} from './readonly-session.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'

/** Trusted provider evidence uses this Connector's performance.now() clock.
 * The provider owns current assignment authority and complete aggregation.
 * StatusMessage itself carries neither assignment IDs nor freshness evidence.
 */
export type CompleteFarmSnapshot = Readonly<{
  assignmentRefs: readonly AssignmentRef[]
  complete: true
  printers: readonly PrinterState[]
  capturedAtMonoMs: number
  validUntilMonoMs: number
}>
export type FarmSnapshotProvider = (
  input: Readonly<{
    binding: VerifiedRtcAdmission['binding']
    assignmentRefs: readonly AssignmentRef[]
    signal: AbortSignal
    onComplete: (snapshot: CompleteFarmSnapshot) => void
    /** Partial/unavailable data or changed assignment authority is terminal. */
    onUnavailable: () => void
  }>,
) => { close(): void }
type Client = {
  start(): Promise<void>
  subscribeVerifiedAdmission(
    listener: (admission: VerifiedRtcAdmission) => void,
  ): () => void
  subscribeTerminal(listener: (reason: string) => void): () => void
  sendStatus(message: unknown): boolean
  close(reason?: string): void
}
/** Display-only sender. No production provider is installed by this module.
 * A changed mapping requires a new authenticated session, never a stale replay.
 */
export class FarmStatusSender {
  #client: Client
  #refs: readonly AssignmentRef[]
  #open: FarmSnapshotProvider
  #signal: AbortSignal
  #controller = new AbortController()
  #unsubscribe = () => {}
  #unsubscribeTerminal = () => {}
  #provider: { close(): void } | undefined
  #admission: VerifiedRtcAdmission | undefined
  #terminal = false
  #seq = 0
  #captured = -1
  #sourceDeadline = Infinity
  #sending = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #abort = () => this.close('aborted')
  constructor(options: {
    client: Client
    assignmentRefs: readonly AssignmentRef[]
    openSnapshots: FarmSnapshotProvider
    signal: AbortSignal
  }) {
    this.#client = options.client
    this.#refs = snapshotAssignmentRefs(
      options.assignmentRefs,
      options.assignmentRefs[0]?.agentId ?? '',
    )
    this.#open = options.openSnapshots
    this.#signal = options.signal
    this.#signal.addEventListener('abort', this.#abort, { once: true })
    if (this.#signal.aborted) {
      this.close('aborted')
      return
    }
    try {
      const unsubscribeTerminal = this.#client.subscribeTerminal((reason) =>
        this.close(reason),
      )
      if (this.#terminal) {
        unsubscribeTerminal()
        return
      }
      this.#unsubscribeTerminal = unsubscribeTerminal
      const unsubscribe = this.#client.subscribeVerifiedAdmission((admission) =>
        this.admit(admission),
      )
      if (this.#terminal) unsubscribe()
      else this.#unsubscribe = unsubscribe
    } catch {
      this.close('subscription-failed')
      throw Error('Sender subscription failed')
    }
  }
  start() {
    return this.#client.start()
  }
  private current() {
    if (this.#terminal) return false
    const admission = this.#admission
    if (
      admission &&
      (performance.now() >=
        Math.min(admission.deadlineMonoMs, this.#sourceDeadline) ||
        Date.now() >= admission.binding.expires_at)
    ) {
      this.close('lease-expired')
      return false
    }
    return true
  }
  private admit(input: VerifiedRtcAdmission) {
    if (!this.current()) return
    if (this.#admission) {
      this.close('admission-replacement')
      return
    }
    try {
      const admission = immutableAdmission(input.binding, input.deadlineMonoMs)
      this.#refs = snapshotAssignmentRefs(
        this.#refs,
        admission.binding.agent_id,
      )
      this.#admission = admission
      if (!this.current()) return
      this.schedule(admission.deadlineMonoMs)
      const provider = this.#open(
        Object.freeze({
          binding: admission.binding,
          assignmentRefs: this.#refs,
          signal: this.#controller.signal,
          onComplete: (value) => this.complete(value),
          onUnavailable: () => this.close('source-unavailable'),
        }),
      )
      if (!provider || typeof provider.close !== 'function')
        runSynchronous(() => provider)
      const owned = Object.freeze({ close: provider.close.bind(provider) })
      if (!this.current()) owned.close()
      else this.#provider = owned
    } catch {
      this.close('source-invalid')
    }
  }
  private schedule(deadline: number) {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(
      () => this.close('source-expired'),
      Math.max(0, deadline - performance.now()),
    )
  }
  private complete(input: CompleteFarmSnapshot) {
    if (!this.current() || !this.#admission) return
    if (this.#sending) {
      this.close('source-reentrancy')
      return
    }
    try {
      const refs = snapshotAssignmentRefs(
        input.assignmentRefs,
        this.#admission.binding.agent_id,
      )
      const same =
        refs.length === this.#refs.length &&
        refs.every((ref) =>
          this.#refs.some(
            (expected) =>
              ref.assignmentId === expected.assignmentId &&
              ref.agentId === expected.agentId &&
              ref.printerKey === expected.printerKey,
          ),
        )
      const captured = input.capturedAtMonoMs,
        until = input.validUntilMonoMs,
        now = performance.now()
      if (
        input.complete !== true ||
        !same ||
        !Number.isFinite(captured) ||
        captured < 0 ||
        captured > now ||
        captured < this.#captured ||
        !Number.isFinite(until) ||
        until < 0 ||
        now >= until ||
        until > this.#admission.deadlineMonoMs ||
        this.#seq >= 1024
      )
        throw Error('Incomplete or stale source')
      const message = validatedStatusMessage(
        { t: 'snapshot', seq: this.#seq, printers: input.printers },
        this.#refs,
      )
      // Parsed copies precede the external send callback; no caller array survives.
      if (!this.current()) return
      if (performance.now() >= until) throw Error('Expired source')
      this.#captured = captured
      this.#seq++
      this.#sending = true
      this.#sourceDeadline = until
      const outcome = this.#client.sendStatus(message)
      if (outcome !== true) {
        runSynchronous(() => outcome)
        this.close('status-send')
        return
      }
      if (this.current()) this.schedule(until)
    } catch {
      this.close('source-invalid')
    } finally {
      this.#sending = false
    }
  }
  close(reason = 'closed') {
    if (this.#terminal) return
    this.#terminal = true
    clearTimeout(this.#timer)
    this.#controller.abort()
    this.#signal.removeEventListener('abort', this.#abort)
    try {
      this.#unsubscribe()
    } catch {}
    try {
      this.#unsubscribeTerminal()
    } catch {}
    try {
      this.#provider?.close()
    } catch {}
    try {
      this.#client.close(reason)
    } catch {}
  }
}
