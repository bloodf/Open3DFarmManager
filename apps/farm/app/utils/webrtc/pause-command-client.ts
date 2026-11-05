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
  /** Notified once per command with its final outcome. */
  onOutcome?(outcome: PauseCommandOutcome): void
  /** Aborted when the control session ends. */
  signal?: AbortSignal
}>

export type PauseCommandClientState = Readonly<{
  /** The browser sent its issued capability and admission proof. */
  admitted: boolean
  /** The command was handed to the transport. */
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
  /** Resolves when the retained asynchronous work actually settled. */
  readonly settled: Promise<void>
}>

const inert = () => false

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
  const sendPhase = options.transport?.sendPhase ?? inert
  const sendCommand = options.transport?.sendCommand ?? inert
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const waiters = new Set<() => void>()
  let binding: ControlSessionBinding | undefined
  let browserProofWire = ''
  let connectorProofWire = ''
  let admission: Promise<SignedPauseCapabilityV1> | undefined
  let admitted = false
  let commandSent = false
  let aborted = false
  let command:
    | { id: string; settle: (outcome: PauseCommandOutcome) => void }
    | undefined
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work)
    const drop = () => {
      pending.delete(work)
      if (!pending.size) {
        for (const waiter of [...waiters]) waiter()
        waiters.clear()
      }
    }
    void work.then(drop, drop)
    return work
  }
  function settleCommand(outcome: PauseCommandOutcome): void {
    const current = command
    if (!current) return
    command = undefined
    current.settle(outcome)
    options.onOutcome?.(outcome)
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
    const proof = await signPauseAdmissionProof(challenge, options.privateKey)
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
      !sendPhase({
        t: 'control.capability',
        wire: encodePauseCapability(issued),
      })
    )
      throw new Error('Pause capability phase refused')
    if (!sendPhase({ t: 'control.admission-proof', wire: admissionProofWire }))
      throw new Error('Pause admission proof phase refused')
    admitted = true
    return issued
  }
  async function runPause(): Promise<PauseCommandOutcome> {
    if (aborted || commandSent) return 'rejected'
    const work = admission
    if (!work) return 'rejected'
    let issued: SignedPauseCapabilityV1
    try {
      issued = await work
    } catch {
      return 'rejected'
    }
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
    commandSent = true
    const wire = encodeCommandV2(signed)
    return await new Promise<PauseCommandOutcome>((resolve) => {
      command = { id: signed.cmd_id, settle: resolve }
      if (!sendCommand({ t: 'control.command', wire }))
        settleCommand('rejected')
    })
  }
  function abort(): void {
    if (aborted) return
    aborted = true
    controller.abort()
    // A command already on the wire keeps its unknown outcome. Nothing is
    // cancelled, resent or pretended.
    settleCommand(commandSent ? 'outcome-unknown' : 'rejected')
  }
  if (options.signal) {
    const signal = options.signal
    const onAbort = () => abort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  }
  return Object.freeze({
    proofsReady(ready: PauseProofsReady): void {
      if (aborted) return
      binding = ready.binding
      browserProofWire = ready.browserProofWire
      connectorProofWire = ready.connectorProofWire
    },
    phase(frame: Readonly<PausePhaseFrame>): void {
      if (aborted || admission) return
      if (frame.t !== 'control.admission-nonce') return
      const work = track(runAdmission(frame.admission_nonce))
      admission = work
      void work.catch(() => {
        // A failed admission never reaches the transport and never retries.
        if (admission === work) admission = undefined
      })
    },
    data(frame: Readonly<PauseDataFrame>): void {
      if (frame.t !== 'control.result') return
      const current = command
      if (!current || frame.command_id !== current.id) return
      settleCommand(frame.outcome)
    },
    pause(): Promise<PauseCommandOutcome> {
      return track(runPause())
    },
    abort,
    get state(): PauseCommandClientState {
      return Object.freeze({
        admitted,
        commandSent,
        pending: pending.size > 0,
        aborted,
      })
    },
    get settled(): Promise<void> {
      if (!pending.size) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.add(resolve))
    },
  })
}
