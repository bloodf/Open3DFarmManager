import type { ConnectorIdentity } from '../identity/store.ts'
import { z } from 'zod'
import {
  BrowserDeviceTextId,
  BrowserDeviceUuid,
} from '../../../farm-protocol/src/browser-device-proof.ts'
import {
  PairingProofAudience,
  PairingProofOrigin,
} from '../../../farm-protocol/src/pairing-proof.ts'
import {
  ControlSessionBinding,
  decodeControlProof,
  encodeControlProof,
  signControlSessionProof,
  verifyControlSessionProof,
  validateControlSessionBinding,
  controlDtlsFingerprint,
} from '../../../farm-protocol/src/control-session-binding.ts'
import {
  PauseChannelFrame,
  decodePauseChannelFrame,
  encodePauseChannelFrame,
  MAX_PAUSE_CHANNEL_WIRE_BYTES,
  MAX_PAUSE_CHANNEL_SEQUENCE,
} from '../../../farm-protocol/src/pause-channel.ts'
import { decodeCommandV2 } from '../../../farm-protocol/src/command-v2.ts'
import { BoundedReceive } from './bounded-receive.ts'
import type { EffectiveRtcDescriptions } from './rtc-descriptions.ts'

export const PauseExpectedContext = z.strictObject({
  transportId: BrowserDeviceUuid,
  farmId: BrowserDeviceUuid,
  agentId: BrowserDeviceUuid,
  assignmentId: BrowserDeviceUuid,
  accountId: BrowserDeviceTextId.optional(),
  keyId: BrowserDeviceUuid.optional(),
  origin: PairingProofOrigin.optional(),
  audience: PairingProofAudience.optional(),
})
export type PauseExpectedContext = z.infer<typeof PauseExpectedContext>
export type PauseBrowserExpectedContext = PauseExpectedContext &
  Required<
    Pick<PauseExpectedContext, 'accountId' | 'keyId' | 'origin' | 'audience'>
  >
export type PausePhaseFrame = Extract<
  PauseChannelFrame,
  {
    t:
      | 'control.admission-nonce'
      | 'control.capability'
      | 'control.admission-proof'
  }
>
type StripEnvelope<T> = T extends PausePhaseFrame
  ? Omit<T, 'v' | 'transport_id' | 'seq'>
  : never
export type PausePhaseMessage = StripEnvelope<PausePhaseFrame>
/** Bounded command/result channel. Transport delivery only, never authority. */
export type PauseDataFrame = Extract<
  PauseChannelFrame,
  { t: 'control.command' | 'control.result' }
>
type StripDataEnvelope<T> = T extends PauseDataFrame
  ? Omit<T, 'v' | 'transport_id' | 'seq'>
  : never
export type PauseDataMessage = StripDataEnvelope<PauseDataFrame>
export type PauseCommandMessage = Extract<
  PauseDataMessage,
  { t: 'control.command' }
>
export type PauseResultMessage = Extract<
  PauseDataMessage,
  { t: 'control.result' }
>
export type PauseCommandOutcome = Extract<
  PauseDataFrame,
  { t: 'control.result' }
>['outcome']
export type PauseProofsReady = Readonly<{
  binding: Readonly<
    Omit<ControlSessionBinding, 'browser_public_key'> & {
      browser_public_key: Readonly<ControlSessionBinding['browser_public_key']>
    }
  >
  deadlineMonoMs: number
  browserProofWire: string
  connectorProofWire: string
}>
export const PAUSE_PENDING_BYTES = 4 * MAX_PAUSE_CHANNEL_WIRE_BYTES
type Identity =
  | { role: 'connector'; identity: ConnectorIdentity }
  | { role: 'browser'; privateKey: CryptoKey }
export type PauseSessionOptions = Identity & {
  expected: PauseExpectedContext
  authDeadline?: number
  lifetimeDeadline?: number
  send(wire: string): void
  onProofsReady?(value: PauseProofsReady): void
  onPhase?(frame: Readonly<PausePhaseFrame>): void
  /** Optional command/result handler. Absent means the data channel is disabled. */
  onData?(frame: Readonly<PauseDataFrame>): void
  onTerminal?(reason: string): void
}
export function pausePrivateKey(key: CryptoKey): void {
  if (
    key.type !== 'private' ||
    key.extractable ||
    key.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.algorithm) ||
    key.algorithm.namedCurve !== 'P-256' ||
    key.usages.length !== 1 ||
    key.usages[0] !== 'sign'
  )
    throw Error('Nonextractable P-256 signing key required')
}
export function pauseSynchronous(callback: () => unknown): void {
  const result = callback()
  if (result !== undefined) {
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function')
    )
      void Promise.resolve(result).catch(() => {})
    throw Error('Synchronous pause callback required')
  }
}
export function checkPauseEffectiveDescriptions(
  binding: ControlSessionBinding,
  role: 'browser' | 'connector',
  captured: EffectiveRtcDescriptions,
  current: EffectiveRtcDescriptions,
): void {
  if (
    current.local.type !== (role === 'connector' ? 'offer' : 'answer') ||
    current.remote.type !== (role === 'browser' ? 'offer' : 'answer') ||
    current.local.type !== captured.local.type ||
    current.remote.type !== captured.remote.type ||
    current.local.sdp !== captured.local.sdp ||
    current.remote.sdp !== captured.remote.sdp ||
    controlDtlsFingerprint(current.local.sdp) !==
      (role === 'browser' ? binding.browser_dtls : binding.connector_dtls) ||
    controlDtlsFingerprint(current.remote.sdp) !==
      (role === 'browser' ? binding.connector_dtls : binding.browser_dtls)
  )
    throw Error('Control descriptions changed')
}
export function assertPauseExpected(
  binding: ControlSessionBinding,
  expected: PauseExpectedContext,
): void {
  if (
    binding.transport_id !== expected.transportId ||
    binding.farm_id !== expected.farmId ||
    binding.agent_id !== expected.agentId ||
    binding.assignment_id !== expected.assignmentId ||
    (expected.accountId !== undefined &&
      binding.account_id !== expected.accountId) ||
    (expected.keyId !== undefined && binding.key_id !== expected.keyId) ||
    (expected.origin !== undefined && binding.origin !== expected.origin) ||
    (expected.audience !== undefined && binding.audience !== expected.audience)
  )
    throw Error('Unexpected control binding')
}
/** Cryptographic session only. Peers must establish actual certificate/SDP matching before activate(). */
export class PauseControlSession {
  readonly closed: Promise<void>
  #resolveClosed: () => void = () => {}
  #options: Readonly<PauseSessionOptions>
  #queue: BoundedReceive
  #work = new Set<Promise<unknown>>()
  #admitting = 0
  #binding: ControlSessionBinding | undefined
  #terminal: string | undefined
  #activated = false
  #localProof: string | undefined
  #remoteProof: string | undefined
  #localReady = false
  #remoteReady = false
  #notified = false
  #sending = false
  #sendSeq = 0
  #sentProofs = 0
  #receiveSeq = 0
  #sentPhases = new Set<string>()
  #receivedPhases = new Set<string>()
  #commandSent = false
  #commandReceived = false
  #resultSent = false
  #resultReceived = false
  #commandId: string | undefined
  #lastMono: number
  #lastWall: number
  #authDeadline: number
  #lifetimeDeadline: number
  #authTimer: ReturnType<typeof setTimeout>
  #lifeTimer: ReturnType<typeof setTimeout>
  constructor(options: PauseSessionOptions) {
    const expected = Object.freeze(PauseExpectedContext.parse(options.expected))
    if (options.role === 'browser') pausePrivateKey(options.privateKey)
    const now = performance.now()
    for (const cap of [options.authDeadline, options.lifetimeDeadline])
      if (cap !== undefined && (!Number.isFinite(cap) || cap <= now))
        throw Error('Invalid pause deadline')
    this.#lastMono = now
    this.#lastWall = Date.now()
    this.#authDeadline = Math.min(now + 8000, options.authDeadline ?? Infinity)
    this.#lifetimeDeadline = Math.min(
      now + 30000,
      options.lifetimeDeadline ?? Infinity,
    )
    this.#options = Object.freeze({ ...options, expected })
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#queue = new BoundedReceive({
      paused: true,
      byteAccounting: 'utf8',
      limits: {
        frameBytes: MAX_PAUSE_CHANNEL_WIRE_BYTES,
        pendingFrames: 4,
        retainedBytes: PAUSE_PENDING_BYTES,
        totalFrames: MAX_PAUSE_CHANNEL_SEQUENCE + 1,
      },
      process: (wire) => this.inspect(wire),
      reject: () => this.close('capacity'),
    })
    this.#authTimer = setTimeout(
      () => this.close('auth-deadline'),
      Math.max(0, this.#authDeadline - now),
    )
    this.#lifeTimer = setTimeout(
      () => this.close('expired'),
      Math.max(0, this.#lifetimeDeadline - now),
    )
  }
  get active(): boolean {
    return this.current()
  }
  private current(): boolean {
    if (this.#terminal) return false
    const mono = performance.now(),
      wall = Date.now()
    if (
      !Number.isFinite(mono) ||
      !Number.isSafeInteger(wall) ||
      mono < this.#lastMono ||
      wall < this.#lastWall ||
      mono >= this.#lifetimeDeadline ||
      (!this.#notified && mono >= this.#authDeadline) ||
      (this.#binding &&
        (wall < this.#binding.issued_at || wall >= this.#binding.expires_at))
    ) {
      this.close('expired')
      return false
    }
    this.#lastMono = mono
    this.#lastWall = wall
    return true
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.#work.add(promise)
    void promise.then(
      () => this.finished(promise),
      () => this.finished(promise),
    )
    return promise
  }
  private settled() {
    if (this.#terminal && !this.#work.size && !this.#admitting)
      this.#resolveClosed()
  }
  private finished(promise: Promise<unknown>) {
    this.#work.delete(promise)
    this.settled()
  }
  receive(raw: unknown): void {
    if (!this.current()) return
    this.#admitting++
    try {
      this.track(this.#queue.receive(raw))
    } finally {
      this.#admitting--
      this.settled()
    }
  }
  activate(input: unknown): Promise<void> {
    if (!this.current() || this.#activated) {
      this.close('duplicate-activation')
      return Promise.resolve()
    }
    this.#activated = true
    return this.track(
      this.initialize(input).catch(() => this.close('auth-failed')),
    )
  }
  private async initialize(input: unknown) {
    const binding = await validateControlSessionBinding(input)
    if (!this.current()) return
    assertPauseExpected(binding, this.#options.expected)
    Object.freeze(binding.browser_public_key)
    this.#binding = Object.freeze(binding)
    this.#lifetimeDeadline = Math.min(
      this.#lifetimeDeadline,
      performance.now() + binding.expires_at - Date.now(),
    )
    clearTimeout(this.#lifeTimer)
    this.#lifeTimer = setTimeout(
      () => this.close('expired'),
      Math.max(0, this.#lifetimeDeadline - performance.now()),
    )
    if (!this.current()) return
    const proof =
      this.#options.role === 'connector'
        ? await this.#options.identity.signControlSessionProof({
            binding,
            expectedAgentId: this.#options.expected.agentId,
          })
        : {
            v: 1 as const,
            role: 'browser' as const,
            binding,
            signature: await signControlSessionProof(
              binding,
              'browser',
              this.#options.privateKey,
            ),
          }
    if (!this.current()) return
    const wire = encodeControlProof(proof)
    if (
      !(await this.expectedProof(wire, this.#options.role)) ||
      !this.current()
    )
      return this.close('local-proof')
    this.#localProof = wire
    if (!this.send({ t: 'control.proof', wire })) return
    this.#queue.activate()
  }
  private async expectedProof(
    wire: string,
    role: 'connector' | 'browser',
  ): Promise<boolean> {
    const proof = decodeControlProof(wire),
      binding = this.#binding
    return (
      !!binding &&
      proof.role === role &&
      encodeControlProof({ ...proof, binding }) === wire &&
      (await verifyControlSessionProof(binding, role, proof.signature))
    )
  }
  private async inspect(wire: string): Promise<void> {
    try {
      if (!this.current()) return
      const frame = decodePauseChannelFrame(wire)
      if (
        frame.transport_id !== this.#options.expected.transportId ||
        frame.seq !== this.#receiveSeq
      )
        throw Error('Pause sequence')
      this.#receiveSeq++
      if (frame.t === 'control.close') {
        this.close(frame.reason)
        return
      }
      if (frame.seq === 0) {
        if (frame.t !== 'control.proof' || this.#remoteProof)
          throw Error('Expected initial control proof')
        if (
          !(await this.expectedProof(
            frame.wire,
            this.#options.role === 'connector' ? 'browser' : 'connector',
          )) ||
          !this.current()
        )
          return this.close('remote-proof')
        this.#remoteProof = frame.wire
        this.#localReady = true
        if (!this.send({ t: 'control.proofs-ready' })) return
        return
      }
      if (frame.seq === 1) {
        if (
          frame.t !== 'control.proofs-ready' ||
          !this.#remoteProof ||
          !this.#localProof ||
          !this.#localReady ||
          this.#remoteReady
        )
          throw Error('Expected peer readiness')
        this.#remoteReady = true
        this.#notified = true
        clearTimeout(this.#authTimer)
        const binding = this.#binding!
        const copy = ControlSessionBinding.parse(binding)
        Object.freeze(copy.browser_public_key)
        Object.freeze(copy)
        const ready = Object.freeze({
          binding: copy,
          deadlineMonoMs: this.#lifetimeDeadline,
          browserProofWire:
            this.#options.role === 'browser'
              ? this.#localProof
              : this.#remoteProof,
          connectorProofWire:
            this.#options.role === 'connector'
              ? this.#localProof
              : this.#remoteProof,
        })
        pauseSynchronous(() => this.#options.onProofsReady?.(ready))
        this.current()
        return
      }
      if (frame.t === 'control.command' || frame.t === 'control.result') {
        this.data(frame)
        return
      }
      if (!this.#notified || !this.phaseAllowed(frame, false))
        throw Error('Unexpected pause phase')
      this.#receivedPhases.add(frame.t)
      if (!this.current()) return
      pauseSynchronous(() =>
        this.#options.onPhase?.(Object.freeze(frame as PausePhaseFrame)),
      )
      this.current()
    } catch {
      this.close('invalid-frame')
    }
  }
  private phaseAllowed(
    frame: Pick<PauseChannelFrame, 't'>,
    sending: boolean,
  ): boolean {
    const connector = (this.#options.role === 'connector') === sending
    const seen = sending ? this.#sentPhases : this.#receivedPhases
    if (seen.has(frame.t)) return false
    if (connector) return frame.t === 'control.admission-nonce'
    return (
      (frame.t === 'control.capability' ||
        frame.t === 'control.admission-proof') &&
      (sending ? this.#receivedPhases : this.#sentPhases).has(
        'control.admission-nonce',
      )
    )
  }
  /** Bounded command/result channel. A delivered frame is never authority. */
  private data(frame: PauseDataFrame): void {
    if (!this.#notified) throw Error('Unexpected pause data')
    if (!this.#options.onData) throw Error('Pause data disabled')
    if (frame.t === 'control.command') {
      if (this.#options.role !== 'connector')
        throw Error('Unexpected pause data')
      if (this.#commandReceived) throw Error('Duplicate pause command')
      if (
        !this.#receivedPhases.has('control.capability') ||
        !this.#receivedPhases.has('control.admission-proof')
      )
        throw Error('Unexpected pause data')
      const command = decodeCommandV2(frame.wire)
      // Reserve before the callback so a reentrant call cannot open a second command.
      this.#commandReceived = true
      this.#commandId = command.cmd_id
      this.publish(frame)
      return
    }
    if (this.#options.role !== 'browser') throw Error('Unexpected pause data')
    if (this.#resultReceived) throw Error('Duplicate pause result')
    if (!this.#commandSent || !this.#commandId)
      throw Error('Unexpected pause result')
    if (frame.command_id !== this.#commandId)
      throw Error('Mismatched pause result')
    this.#resultReceived = true
    this.publish(frame)
  }
  private publish(frame: PauseDataFrame): void {
    try {
      pauseSynchronous(() => this.#options.onData?.(Object.freeze(frame)))
    } catch {
      this.close('data-callback')
    }
  }
  /** Browser only. One command per control peer, after the admission sequence. */
  sendCommand(command: PauseCommandMessage): boolean {
    if (!this.#options.onData) return this.invalidSend()
    if (this.#options.role !== 'browser') return this.invalidSend()
    if (!this.current() || !this.#notified) return false
    try {
      if (this.#commandSent) throw Error('Duplicate pause command')
      if (
        !this.#sentPhases.has('control.capability') ||
        !this.#sentPhases.has('control.admission-proof')
      )
        throw Error('Unexpected pause command')
      const decoded = decodeCommandV2(command.wire)
      // Reserve before the send so a reentrant call cannot send a second command.
      this.#commandSent = true
      this.#commandId = decoded.cmd_id
      return this.send(command)
    } catch {
      this.close('invalid-send')
      return false
    }
  }
  /** Connector only. One result per received command, correlated by command id. */
  sendResult(result: PauseResultMessage): boolean {
    if (!this.#options.onData) return this.invalidSend()
    if (this.#options.role !== 'connector') return this.invalidSend()
    if (!this.current() || !this.#notified) return false
    try {
      if (this.#resultSent) throw Error('Duplicate pause result')
      if (!this.#commandReceived || !this.#commandId)
        throw Error('Unexpected pause result')
      if (result.command_id !== this.#commandId)
        throw Error('Mismatched pause result')
      PauseChannelFrame.parse({
        v: 1,
        t: 'control.result',
        transport_id: this.#options.expected.transportId,
        seq: 0,
        command_id: result.command_id,
        outcome: result.outcome,
      })
      // Reserve before the send so a reentrant call cannot send a second result.
      this.#resultSent = true
      return this.send(result)
    } catch {
      this.close('invalid-send')
      return false
    }
  }
  private invalidSend(): boolean {
    this.close('invalid-send')
    return false
  }
  sendPhase(input: PausePhaseMessage): boolean {
    if (!this.current() || !this.#notified) return false
    try {
      const frame = PauseChannelFrame.parse({
        ...input,
        v: 1,
        transport_id: this.#options.expected.transportId,
        seq: this.#sendSeq,
      })
      if (!this.phaseAllowed(frame, true)) throw Error('Invalid outbound phase')
      this.#sentPhases.add(frame.t)
      return this.send(frame)
    } catch {
      this.close('invalid-send')
      return false
    }
  }
  private send(
    input:
      | Readonly<{ t: string; wire?: string }>
      | PausePhaseMessage
      | PauseDataMessage,
  ): boolean {
    if (
      !this.current() ||
      this.#sending ||
      this.#sendSeq > MAX_PAUSE_CHANNEL_SEQUENCE
    ) {
      this.close('send-state')
      return false
    }
    try {
      const wire = encodePauseChannelFrame({
        ...input,
        v: 1,
        transport_id: this.#options.expected.transportId,
        seq: this.#sendSeq,
      })
      if (!this.current()) return false
      this.#sendSeq++
      this.#sending = true
      this.#options.send(wire)
      if (input.t === 'control.proof') this.#sentProofs++
      return this.current()
    } catch {
      this.close('send-failed')
      return false
    } finally {
      this.#sending = false
    }
  }
  close(reason = 'closed'): void {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    clearTimeout(this.#authTimer)
    clearTimeout(this.#lifeTimer)
    this.#queue.close()
    try {
      pauseSynchronous(() => this.#options.onTerminal?.(this.#terminal!))
    } catch {
      /* Terminal state is already reserved. */
    }
    this.settled()
  }
  diagnostics() {
    return Object.freeze({
      proofsReady: this.#notified && !this.#terminal,
      sentProofs: this.#sentProofs,
      receivedProofs: Number(this.#remoteProof !== undefined),
      terminal: this.#terminal !== undefined,
      commandsEnabled: false as const,
      pending: this.#queue.snapshot().pending,
      retainedBytes: this.#queue.snapshot().retainedBytes,
    })
  }
}
