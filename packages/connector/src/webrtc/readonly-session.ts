import { StatusMessage } from '../../../farm-protocol/src/channel.ts'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  RtcSessionBinding,
  type RtcPeerRole,
  encodeRtcProof,
  verifyExpectedRtcProof,
  decodeRtcProof,
} from '../../../farm-protocol/src/rtc-session-binding.ts'
import { boundRtcApplicationFrame } from './rtc-proof-inbox.ts'

/** Callback contracts are synchronous; a returned promise is rejected and never awaited. */
export function runSynchronous(callback: () => unknown): void {
  const result = callback()
  if (result !== undefined) {
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    )
      void Promise.resolve(result).catch(() => {})
    throw Error('Synchronous callback required')
  }
}
export type AssignmentRef = Readonly<{
  assignmentId: string
  agentId: string
  printerKey: string
}>
export type ReadonlyStatusMessage = Readonly<{
  t: 'snapshot'
  seq: number
  printers: readonly Readonly<
    ReturnType<typeof StatusMessage.parse>['printers'][number]
  >[]
}>
export type VerifiedRtcAdmission = Readonly<{
  binding: Readonly<
    Omit<RtcSessionBinding, 'browser_public_key'> & {
      browser_public_key: Readonly<RtcSessionBinding['browser_public_key']>
    }
  >
  deadlineMonoMs: number
}>
export function immutableAdmission(
  binding: unknown,
  deadlineMonoMs: number,
): VerifiedRtcAdmission {
  if (!Number.isFinite(deadlineMonoMs) || deadlineMonoMs <= performance.now())
    throw Error('Expired admission')
  const copy = RtcSessionBinding.parse(binding)
  const wall = Date.now(),
    now = performance.now()
  const deadline = Math.min(deadlineMonoMs, now + copy.expires_at - wall)
  if (wall < copy.issued_at || deadline <= now) throw Error('Expired admission')
  Object.freeze(copy.browser_public_key)
  return Object.freeze({
    binding: Object.freeze(copy),
    deadlineMonoMs: deadline,
  })
}
export function snapshotAssignmentRefs(
  refs: readonly AssignmentRef[],
  agentId: string,
): readonly AssignmentRef[] {
  if (!Array.isArray(refs) || refs.length > 100) throw Error('Assignment limit')
  const assignments = new Set<string>(),
    printers = new Set<string>()
  return Object.freeze(
    refs.map((ref) => {
      if (
        Object.keys(ref).sort().join(',') !==
          'agentId,assignmentId,printerKey' ||
        BrowserDeviceUuid.parse(ref.agentId) !== agentId ||
        typeof ref.printerKey !== 'string' ||
        ref.printerKey.length < 1 ||
        ref.printerKey.length > 128 ||
        assignments.has(ref.assignmentId) ||
        printers.has(ref.printerKey)
      )
        throw Error('Assignment scope')
      BrowserDeviceUuid.parse(ref.assignmentId)
      assignments.add(ref.assignmentId)
      printers.add(ref.printerKey)
      return Object.freeze({
        assignmentId: ref.assignmentId,
        agentId: ref.agentId,
        printerKey: ref.printerKey,
      })
    }),
  )
}
export function validatedStatusMessage(
  input: unknown,
  refs: readonly AssignmentRef[],
): ReadonlyStatusMessage {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('printers' in input) ||
    !Array.isArray(input.printers) ||
    input.printers.length > 100
  )
    throw Error('Status printer limit')
  const parsed = StatusMessage.parse(input)
  if (
    parsed.printers.length !== refs.length ||
    new Set(parsed.printers.map((p) => p.printerKey)).size !== refs.length ||
    parsed.printers.some(
      (p) => !refs.some((ref) => ref.printerKey === p.printerKey),
    )
  )
    throw Error('Incomplete assignment snapshot')
  boundRtcApplicationFrame(JSON.stringify(parsed))
  return Object.freeze({
    ...parsed,
    printers: Object.freeze(parsed.printers.map((p) => Object.freeze(p))),
  })
}
export type GenuineStatusOptions = Readonly<{
  assignmentRefs: readonly AssignmentRef[]
  onStatus?: (message: ReadonlyStatusMessage) => void
}>

/** Local interoperability observation only. No executable command or media. */
export const READONLY_FIXTURE_STATUS =
  '{"kind":"readonly-status","value":"fixture-idle"}'
type Options = {
  binding: unknown
  role: RtcPeerRole
  authDeadline: number
  lifetimeDeadline: number
  signProof: (binding: RtcSessionBinding) => unknown | Promise<unknown>
  sendProof: (wire: string) => void
  sendApplication: (wire: string) => void
  genuineStatus?: GenuineStatusOptions
  onVerified: () => void
  onReadonly: () => void
}
/** Role-proof session after the adapter has checked actual DTLS certificates.
 * Trusted binding admission and role proof do not establish registry enrollment,
 * current server authorization, a camera lease or printer-command authority.
 */
export class ReadonlyRtcSession {
  #options: Readonly<Options>
  #binding: RtcSessionBinding
  #state: 'pending' | 'verified' | 'readonly' = 'pending'
  #reason = ''
  #localProof = false
  #remoteProof = false
  #remoteVerified = false
  #started = false
  #genuine: GenuineStatusOptions | undefined
  #lastReceivedSeq = -1
  #lastSentSeq = -1
  #sentStatus = 0
  #sendingStatus = false
  #pendingStatus: string[] = []
  #receivingStatus = false
  #notifyingVerified = false
  #accepted = 0
  #acceptedSamples: string[] = []
  #leaseDeadline: number
  #timer: ReturnType<typeof setTimeout>
  constructor(options: Options) {
    this.#options = Object.freeze({ ...options })
    this.#binding = RtcSessionBinding.parse(options.binding)
    if (options.genuineStatus)
      this.#genuine = Object.freeze({
        ...options.genuineStatus,
        assignmentRefs: snapshotAssignmentRefs(
          options.genuineStatus.assignmentRefs,
          this.#binding.agent_id,
        ),
      })
    Object.freeze(this.#binding.browser_public_key)
    Object.freeze(this.#binding)
    const remaining = this.#binding.expires_at - Date.now()
    this.#leaseDeadline = Math.min(
      performance.now() + remaining,
      options.lifetimeDeadline,
    )
    this.#timer = setTimeout(() => this.close('deadline'), 0)
    this.schedule()
    if (Date.now() < this.#binding.issued_at || remaining <= 0)
      this.close('binding-expired')
  }
  private current() {
    if (this.#state === 'readonly') return false
    if (
      performance.now() >= this.#leaseDeadline ||
      (this.#state === 'pending' &&
        performance.now() >= this.#options.authDeadline) ||
      Date.now() < this.#binding.issued_at ||
      Date.now() >= this.#binding.expires_at
    ) {
      this.close('deadline')
      return false
    }
    return true
  }
  private schedule() {
    clearTimeout(this.#timer)
    const end =
      this.#state === 'pending'
        ? Math.min(this.#leaseDeadline, this.#options.authDeadline)
        : this.#leaseDeadline
    this.#timer = setTimeout(
      () => this.close('deadline'),
      Math.max(0, end - performance.now()),
    )
  }
  async start() {
    if (this.#started || !this.current()) return
    this.#started = true
    try {
      const proof = await this.#options.signProof(this.#binding)
      if (!this.current()) return
      const wire = encodeRtcProof(proof)
      if (
        !(await verifyExpectedRtcProof(this.#binding, this.#options.role, wire))
      ) {
        this.close('local-proof')
        return
      }
      if (!this.current()) return
      this.#options.sendProof(wire)
      this.#localProof = true
      this.finishVerification()
    } catch {
      this.close('local-proof')
    }
  }
  /** Called only by the adapter's bounded canonical proof inbox. */
  async inspectProof(proof: ReturnType<typeof decodeRtcProof>) {
    if (!this.current() || this.#remoteProof || this.#state !== 'pending') {
      this.close('duplicate-or-expired-proof')
      return
    }
    this.#remoteProof = true
    const ok = await verifyExpectedRtcProof(
      this.#binding,
      this.#options.role === 'connector' ? 'browser' : 'connector',
      encodeRtcProof(proof),
    )
    if (!this.current()) return
    if (!ok) {
      this.close('identity-or-binding')
      return
    }
    this.#remoteVerified = true
    this.finishVerification()
  }
  private finishVerification() {
    if (
      !this.current() ||
      this.#state !== 'pending' ||
      !this.#localProof ||
      !this.#remoteVerified
    )
      return
    this.#state = 'verified'
    this.#notifyingVerified = true
    try {
      this.#options.onVerified()
    } finally {
      this.#notifyingVerified = false
    }
    if (this.current()) {
      this.schedule()
      this.drainApplication()
    }
  }
  receiveApplication(raw: unknown) {
    if (!this.current()) return
    try {
      const wire = boundRtcApplicationFrame(raw)
      if (this.#state !== 'verified') {
        if (
          this.#genuine &&
          this.#options.role === 'browser' &&
          this.#pendingStatus.length === 0
        ) {
          this.#pendingStatus.push(wire)
          return
        }
        throw Error('readonly-only')
      }
      // At most two 2 KiB frames, including the active callback's frame.
      if (this.#pendingStatus.length + Number(this.#receivingStatus) >= 2)
        throw Error('Application queue limit')
      this.#pendingStatus.push(wire)
      this.drainApplication()
    } catch {
      this.close('application-frame')
    }
  }
  private drainApplication() {
    if (
      this.#receivingStatus ||
      this.#notifyingVerified ||
      this.#state !== 'verified'
    )
      return
    this.#receivingStatus = true
    try {
      while (this.current()) {
        const wire = this.#pendingStatus.shift()
        if (wire === undefined) break
        this.consumeApplication(wire)
      }
    } finally {
      this.#receivingStatus = false
    }
  }
  private consumeApplication(wire: string) {
    try {
      if (this.#genuine) {
        if (this.#options.role !== 'browser') throw Error('Status direction')
        const message = validatedStatusMessage(
          JSON.parse(wire),
          this.#genuine.assignmentRefs,
        )
        if (
          !Number.isSafeInteger(message.seq) ||
          message.seq <= this.#lastReceivedSeq ||
          this.#accepted === 1024
        )
          throw Error('Status sequence')
        this.#lastReceivedSeq = message.seq
        this.#accepted++
        if (this.#genuine.onStatus)
          runSynchronous(() => this.#genuine?.onStatus?.(message))
        return
      }
      if (wire !== READONLY_FIXTURE_STATUS) throw Error('readonly-only')
      if (this.#accepted === 1024) throw Error('message-budget')
      this.#accepted++
      if (this.#acceptedSamples.length === 16) this.#acceptedSamples.shift()
      this.#acceptedSamples.push('fixture-idle')
    } catch {
      this.close('application-frame')
    }
  }
  sendGenuineStatus(input: unknown) {
    if (
      !this.current() ||
      this.#state !== 'verified' ||
      !this.#localProof ||
      !this.#genuine ||
      this.#options.role !== 'connector' ||
      this.#sendingStatus
    )
      return false
    try {
      const message = validatedStatusMessage(
        input,
        this.#genuine.assignmentRefs,
      )
      if (
        !Number.isSafeInteger(message.seq) ||
        message.seq <= this.#lastSentSeq ||
        this.#sentStatus === 1024
      )
        throw Error('Status sequence')
      if (!this.current()) return false
      this.#lastSentSeq = message.seq
      this.#sentStatus++
      this.#sendingStatus = true
      this.#options.sendApplication(JSON.stringify(message))
      return this.current()
    } catch {
      this.close('status-frame')
      return false
    } finally {
      this.#sendingStatus = false
    }
  }
  sendStatus() {
    if (
      this.#genuine ||
      !this.current() ||
      this.#state !== 'verified' ||
      !this.#localProof
    )
      return false
    try {
      this.#options.sendApplication(READONLY_FIXTURE_STATUS)
      return true
    } catch {
      this.close('send-failed')
      return false
    }
  }
  close(reason = 'closed') {
    if (this.#state === 'readonly') return
    this.#state = 'readonly'
    this.#pendingStatus = []
    this.#reason = reason.slice(0, 64)
    clearTimeout(this.#timer)
    this.#options.onReadonly()
  }
  snapshot() {
    return {
      state: this.#state,
      reason: this.#reason,
      accepted: [...this.#acceptedSamples],
      acceptedTotal: this.#accepted,
      localProof: this.#localProof,
      remoteProof: this.#remoteProof,
      commands_enabled: false,
    }
  }
}
