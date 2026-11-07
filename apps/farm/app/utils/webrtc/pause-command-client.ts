import { canonicalize } from '../../../../../packages/farm-protocol/src/canonical.ts'
import {
  encodeCommandV2,
  MAX_COMMAND_V2_LIFETIME_MS,
  signCommandV2,
  type SignedCommandV2,
} from '../../../../../packages/farm-protocol/src/command-v2.ts'
import {
  controlBindingHash,
  type ControlSessionBinding,
} from '../../../../../packages/farm-protocol/src/control-session-binding.ts'
import { base64url } from '../../../../../packages/farm-protocol/src/encoding.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  PAUSE_POLICY_HARD_MAXIMUMS,
  PauseAdmissionChallenge,
  signPauseAdmissionProof,
  SignedPauseCapabilityV1,
} from '../../../../../packages/farm-protocol/src/pause-capability.ts'
import type {
  PauseCommandMessage,
  PauseCommandOutcome,
  PauseDataFrame,
  PausePhaseFrame,
  PausePhaseMessage,
  PauseProofsReady,
} from '../../../../../packages/connector/src/webrtc/pause-control-session.ts'

/**
 * Issuer seam of the browser client. The real HTTP adapter is wired by the
 * runtime and speaks the existing pause authority endpoints. The client never
 * talks to the server directly and never invents an issuer.
 */
export type PauseCommandIssuer = Readonly<{
  challenge(
    input: Readonly<{
      browserProofWire: string
      connectorProofWire: string
      admissionNonce: string
      signal: AbortSignal
    }>,
  ): Promise<PauseAdmissionChallenge>
  capability(
    input: Readonly<{
      admissionProofWire: string
      signal: AbortSignal
    }>,
  ): Promise<SignedPauseCapabilityV1>
}>

/**
 * Transport seam of the browser client. Both callbacks are optional and
 * default to inert, so a client without a transport can never send anything.
 *
 * The contract is strict and synchronous: a callback must return a boolean.
 * A throwing callback, a non boolean result or a thenable result is a
 * transport fault. The client never treats it as a successful send.
 */
export type PauseCommandTransport = Readonly<{
  sendPhase?(message: PausePhaseMessage): boolean
  sendCommand?(message: PauseCommandMessage): boolean
}>

export type PauseCommandClientOptions = Readonly<{
  /** Existing enrolled nonextractable P-256 private key of this browser. */
  privateKey: CryptoKey
  issuer: PauseCommandIssuer
  transport?: PauseCommandTransport
  /** Wall clock of the browser. Injectable for tests only. */
  now?(): number
  /**
   * Monotonic clock of the browser. It must share the time origin of the
   * control transport, because the transport deadline is expressed in it.
   * Injectable for tests only.
   */
  monotonicNow?(): number
  /** Notified once per command with its final outcome. */
  onOutcome?(outcome: PauseCommandOutcome): void
  /** Aborted when the control session ends. */
  signal?: AbortSignal
}>

export type PauseCommandClientState = Readonly<{
  /** The browser sent its issued capability and admission proof. */
  admitted: boolean
  /**
   * The single operation of this session was reserved. A second `pause` is
   * refused without touching the transport.
   */
  reserved: boolean
  /**
   * The command was handed to the transport, or the hand over was attempted.
   * After this the outcome can be unknown: the client cannot know whether the
   * printer paused.
   */
  commandSent: boolean
  /** Retained asynchronous work is still running. */
  pending: boolean
  /** The client is sealed. Every later send is refused. */
  aborted: boolean
}>

export type PauseCommandClient = Readonly<{
  /** Control proofs of the authenticated session. */
  proofsReady(ready: PauseProofsReady): void
  /** Control phase frames. Only the admission nonce starts the admission. */
  phase(frame: Readonly<PausePhaseFrame>): void
  /** Control data frames. Only the matching result settles the command. */
  data(frame: Readonly<PauseDataFrame>): void
  /** Requests the single pause command of this session. */
  pause(): Promise<PauseCommandOutcome>
  /** Ends the client. Every later send is permanently sealed. */
  abort(): void
  readonly state: PauseCommandClientState
  /**
   * Resolves when the client is terminal, that is aborted or settled by its
   * command, and every retained asynchronous task actually settled. While the
   * client can still accept a phase or a command it never resolves.
   */
  readonly settled: Promise<void>
}>

const inert = () => false

/** Hard bounds of the pause policy. The client never widens them. */
const ADMISSION_MS = PAUSE_POLICY_HARD_MAXIMUMS.admissionMs
const COMMAND_MS = PAUSE_POLICY_HARD_MAXIMUMS.commandMs
const SESSION_MS = PAUSE_POLICY_HARD_MAXIMUMS.capabilityMs

type SendState = 'sent' | 'refused' | 'faulted'

/**
 * Strict synchronous transport contract. A throwing callback, a non boolean
 * result or a thenable result is a transport fault, never a successful send.
 * A refused send is not a proof that the frame stayed inside the transport.
 */
function attemptSend(send: () => boolean): SendState {
  let result: unknown
  try {
    result = send()
  } catch {
    return 'faulted'
  }
  if (result === true) return 'sent'
  if (result === false) return 'refused'
  return 'faulted'
}

/**
 * Library-only browser composition of the pause command path. The client owns
 * the admission exchange and the single signed command of one control session.
 * It signs with the existing enrolled nonextractable P-256 key, uses the
 * existing command and capability schemas, and never adds a frame type.
 */
export function createPauseCommandClient(
  options: PauseCommandClientOptions,
): PauseCommandClient {
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const sendPhase = options.transport?.sendPhase ?? inert
  const sendCommand = options.transport?.sendCommand ?? inert
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const waiters = new Set<() => void>()
  let binding: ControlSessionBinding | undefined
  let browserProofWire = ''
  let connectorProofWire = ''
  let admission: Promise<SignedPauseCapabilityV1> | undefined
  let admissionIssued: SignedPauseCapabilityV1 | undefined
  let admissionGate: Promise<void> | undefined
  let resolveAdmissionGate: (() => void) | undefined
  let admitted = false
  let reserved = false
  let commandSent = false
  let aborted = false
  let terminal = false
  let sessionTimer: ReturnType<typeof setTimeout> | undefined
  let admissionTimer: ReturnType<typeof setTimeout> | undefined
  let resultTimer: ReturnType<typeof setTimeout> | undefined
  /** Monotonic session deadline. It is only ever tightened. */
  let sessionDeadline = Infinity
  let command:
    { id: string; settle: (outcome: PauseCommandOutcome) => void } | undefined
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work)
    const drop = () => {
      pending.delete(work)
      maybeSettled()
    }
    void work.then(drop, drop)
    return work
  }
  function maybeSettled(): void {
    if (!terminal || pending.size) return
    for (const waiter of [...waiters]) waiter()
    waiters.clear()
  }
  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer === undefined) return
    clearTimeout(timer)
  }
  function settleCommand(outcome: PauseCommandOutcome): void {
    const current = command
    if (!current) return
    command = undefined
    clearTimer(resultTimer)
    resultTimer = undefined
    terminal = true
    current.settle(outcome)
    try {
      options.onOutcome?.(outcome)
    } catch {
      // A throwing observer never breaks the settlement of the command.
    }
    maybeSettled()
  }
  function sampleMonotonic(): number | undefined {
    try {
      const value = monotonicNow()
      return Number.isFinite(value) && value >= 0 ? value : undefined
    } catch {
      return undefined
    }
  }
  function armSession(deadlineMonoMs?: number): void {
    const current = sampleMonotonic()
    clearTimer(sessionTimer)
    sessionTimer = undefined
    if (current === undefined) {
      abort()
      return
    }
    // The local bound is armed at construction and is never extended.
    sessionDeadline = Math.min(sessionDeadline, current + SESSION_MS)
    // The transport deadline tightens the bound when it is comparable. A
    // deadline of another clock realm is not comparable, and the transport
    // stays the authority of the session lifetime.
    if (deadlineMonoMs !== undefined && deadlineMonoMs > current)
      sessionDeadline = Math.min(sessionDeadline, deadlineMonoMs)
    if (sessionDeadline <= current) {
      abort()
      return
    }
    sessionTimer = setTimeout(() => {
      sessionTimer = undefined
      abort()
    }, sessionDeadline - current)
  }
  function armAdmission(): void {
    const current = sampleMonotonic()
    clearTimer(admissionTimer)
    admissionTimer = undefined
    if (current === undefined) {
      abort()
      return
    }
    // The original admission window. It is armed once and never reset.
    admissionTimer = setTimeout(() => {
      admissionTimer = undefined
      abort()
      // The admission operation ends here. The issuer call itself is not
      // cancelled, it stays retained until it actually settles.
      resolveAdmissionGate?.()
    }, ADMISSION_MS)
  }
  function armResult(): void {
    clearTimer(resultTimer)
    resultTimer = undefined
    resultTimer = setTimeout(() => {
      resultTimer = undefined
      // The command is on the wire and no result arrived. The client cannot
      // know whether the printer paused.
      settleCommand('outcome-unknown')
    }, COMMAND_MS)
  }
  function scopeMatches(
    issued: Readonly<{
      farm_id: string
      agent_id: string
      account_id: string
      key_id: string
      assignment_id: string
      transport_id: string
      origin: string
      audience: string
      browser_thumbprint: string
      control_binding_sha256: string
    }>,
    expected: ControlSessionBinding,
    bindingHash: string,
  ): boolean {
    return (
      issued.farm_id === expected.farm_id &&
      issued.agent_id === expected.agent_id &&
      issued.account_id === expected.account_id &&
      issued.key_id === expected.key_id &&
      issued.assignment_id === expected.assignment_id &&
      issued.transport_id === expected.transport_id &&
      issued.origin === expected.origin &&
      issued.audience === expected.audience &&
      issued.browser_thumbprint === expected.browser_thumbprint &&
      issued.control_binding_sha256 === bindingHash
    )
  }
  async function runAdmission(
    admissionNonce: string,
  ): Promise<SignedPauseCapabilityV1> {
    const expected = binding
    if (!expected) throw new Error('Missing control binding')
    const bindingHash = await controlBindingHash(expected)
    if (aborted) throw new Error('Pause command client aborted')
    const challenge = PauseAdmissionChallenge.parse(
      await options.issuer.challenge({
        browserProofWire,
        connectorProofWire,
        admissionNonce,
        signal: controller.signal,
      }),
    )
    if (
      challenge.admission_nonce !== admissionNonce ||
      !scopeMatches(challenge, expected, bindingHash)
    )
      throw new Error('Pause admission challenge outside the control scope')
    if (aborted) throw new Error('Pause command client aborted')
    const proof = await signPauseAdmissionProof(challenge, options.privateKey)
    if (aborted) throw new Error('Pause command client aborted')
    const admissionProofWire = encodePauseAdmissionProof(proof)
    const issued = SignedPauseCapabilityV1.parse(
      await options.issuer.capability({
        admissionProofWire,
        signal: controller.signal,
      }),
    )
    if (
      issued.admission_nonce !== admissionNonce ||
      issued.credential_jti !== expected.credential_jti ||
      !scopeMatches(issued, expected, bindingHash) ||
      canonicalize(issued.browser_public_key) !==
        canonicalize(expected.browser_public_key) ||
      issued.issued_at < challenge.issued_at ||
      issued.expires_at > expected.expires_at
    )
      throw new Error('Pause capability outside the control scope')
    if (aborted) throw new Error('Pause command client aborted')
    // The transport accepts each phase once, after the admission nonce.
    if (
      attemptSend(() =>
        sendPhase({
          t: 'control.capability',
          wire: encodePauseCapability(issued),
        }),
      ) !== 'sent'
    )
      throw new Error('Pause capability phase refused')
    if (aborted) throw new Error('Pause command client aborted')
    if (
      attemptSend(() =>
        sendPhase({ t: 'control.admission-proof', wire: admissionProofWire }),
      ) !== 'sent'
    )
      throw new Error('Pause admission proof phase refused')
    if (aborted) throw new Error('Pause command client aborted')
    admitted = true
    return issued
  }
  async function runPause(): Promise<PauseCommandOutcome> {
    try {
      if (aborted) return 'rejected'
      const gate = admissionGate
      if (!gate) return 'rejected'
      // The gate ends with the admission itself or with its own deadline.
      await gate
      const issued = admissionIssued
      if (!issued) return 'rejected'
      if (aborted) return 'rejected'
      const issuedAt = now()
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return 'rejected'
      if (issuedAt < issued.issued_at) return 'rejected'
      const expiresAt = Math.min(
        issuedAt + MAX_COMMAND_V2_LIFETIME_MS,
        issued.expires_at,
      )
      if (expiresAt <= issuedAt) return 'rejected'
      const unsigned = {
        v: 2 as const,
        purpose: 'printer-pause' as const,
        cmd_id: crypto.randomUUID(),
        farm_id: issued.farm_id,
        agent_id: issued.agent_id,
        account_id: issued.account_id,
        key_id: issued.key_id,
        transport_id: issued.transport_id,
        capability_id: issued.capability_id,
        assignment_id: issued.assignment_id,
        action: 'pause' as const,
        args: {},
        issued_at: issuedAt,
        expires_at: expiresAt,
        nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
      }
      let signed: SignedCommandV2
      try {
        signed = await signCommandV2(unsigned, options.privateKey)
      } catch {
        return 'rejected'
      }
      if (aborted) return 'rejected'
      // Reserved before the send: one command per session, never a resend.
      let settle!: (outcome: PauseCommandOutcome) => void
      const reservedCommand = new Promise<PauseCommandOutcome>((resolve) => {
        settle = resolve
      })
      command = { id: signed.cmd_id, settle }
      const wire = encodeCommandV2(signed)
      // From here the command is on its way. A refused or faulted hand over is
      // never reported as a clean rejection: the frame may have left the
      // transport before the failure.
      commandSent = true
      armResult()
      if (
        attemptSend(() => sendCommand({ t: 'control.command', wire })) !==
        'sent'
      )
        settleCommand('outcome-unknown')
      return await reservedCommand
    } catch {
      return 'rejected'
    } finally {
      // The single reserved operation has finished, including pre-send rejection.
      // Outstanding issuer work remains tracked until its real settlement.
      abort()
    }
  }
  function abort(): void {
    if (aborted) return
    aborted = true
    terminal = true
    controller.abort()
    clearTimer(sessionTimer)
    sessionTimer = undefined
    clearTimer(admissionTimer)
    admissionTimer = undefined
    clearTimer(resultTimer)
    resultTimer = undefined
    // A pending admission operation ends with the abort, even when the issuer
    // ignores the signal. The issuer call itself stays retained until it
    // actually settles.
    resolveAdmissionGate?.()
    // A command already on the wire keeps its unknown outcome. Nothing is
    // cancelled, resent or pretended.
    settleCommand(commandSent ? 'outcome-unknown' : 'rejected')
    maybeSettled()
  }
  if (options.signal) {
    const signal = options.signal
    const onAbort = () => abort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  }
  armSession()
  return Object.freeze({
    proofsReady(ready: PauseProofsReady): void {
      if (aborted) return
      if (binding !== undefined) {
        abort()
        return
      }
      // The scope is snapshotted once and never read again.
      binding = Object.freeze({
        ...ready.binding,
        browser_public_key: Object.freeze({
          ...ready.binding.browser_public_key,
        }),
      })
      browserProofWire = ready.browserProofWire
      connectorProofWire = ready.connectorProofWire
      armSession(ready.deadlineMonoMs)
    },
    phase(frame: Readonly<PausePhaseFrame>): void {
      if (aborted || admission) return
      if (frame.t !== 'control.admission-nonce') return
      armAdmission()
      if (aborted) return
      admissionIssued = undefined
      admissionGate = new Promise<void>((resolve) => {
        resolveAdmissionGate = resolve
      })
      const work = track(runAdmission(frame.admission_nonce))
      admission = work
      void work.then(
        (issued) => {
          admissionIssued = issued
          resolveAdmissionGate?.()
        },
        () => {
          resolveAdmissionGate?.()
        },
      )
      void work.catch(() => {
        // A failed admission never reaches the transport and never retries.
        abort()
      })
    },
    data(frame: Readonly<PauseDataFrame>): void {
      if (frame.t !== 'control.result') return
      const current = command
      if (!current || frame.command_id !== current.id) return
      settleCommand(frame.outcome)
    },
    pause(): Promise<PauseCommandOutcome> {
      if (aborted) return Promise.resolve('rejected')
      // One operation per session, reserved before any await.
      if (reserved) return Promise.resolve('rejected')
      reserved = true
      return track(runPause())
    },
    abort,
    get state(): PauseCommandClientState {
      return Object.freeze({
        admitted,
        reserved,
        commandSent,
        pending: pending.size > 0,
        aborted,
      })
    },
    get settled(): Promise<void> {
      if (terminal && !pending.size) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.add(resolve))
    },
  })
}
