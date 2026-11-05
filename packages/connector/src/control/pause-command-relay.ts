import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { decodeCommandV2 } from '../../../farm-protocol/src/command-v2.ts'
import {
  ControlSessionBinding,
  decodeControlProof,
} from '../../../farm-protocol/src/control-session-binding.ts'
import {
  decodePauseAdmissionProof,
  decodePauseCapability,
  PAUSE_POLICY_HARD_MAXIMUMS,
} from '../../../farm-protocol/src/pause-capability.ts'
import type {
  PauseAdmissionToken,
  PauseCapabilityHandle,
  PauseCapabilityRejection,
  PauseIssuer,
  PausePeerHandle,
} from '../auth/pause-capability.ts'
import type {
  PauseCommandOutcome,
  PausePhaseMessage,
  PauseResultMessage,
} from '../webrtc/pause-control-session.ts'
import type { CommandJournalHandle } from './command-journal.ts'
import {
  createPauseDispatcher,
  type PauseDispatchReason,
  type PauseDriver,
} from './pause-dispatcher.ts'
import { readPrinterBinding, type PrinterBinding } from './printer-binding.ts'

/** The four outcomes the control transport can carry. The relay never invents a fifth. */
export type PauseRelayOutcome = PauseCommandOutcome

/** Every reason the relay can report, from the dispatcher and from the verifier. */
export type PauseRelayReason = PauseDispatchReason | PauseCapabilityRejection

export type PauseRelayConfig = Readonly<{
  /** Trusted local issuer keyring. Never sourced from the peer or from a command. */
  authority: Readonly<{ issuers: readonly PauseIssuer[] }>
  clock: Readonly<{ wallNow(): number; monotonicNow(): number }>
  /** Durable journal used by the dispatcher this relay owns. */
  journal: CommandJournalHandle
  /** Fixed-operation driver. The relay never reaches Moonraker directly. */
  driver: PauseDriver
  /**
   * Local provisioned mapping resolver, the only source of a printer binding.
   * It returns `undefined` when the assignment is not provisioned locally. No
   * origin, URL or printer key ever arrives from the peer.
   */
  bindingFor(assignmentId: string): PrinterBinding | undefined
}>

export type PauseRelayPeerInput = Readonly<{
  /** Genuine control binding of the authenticated peer. Its transport id keys the peer. */
  binding: ControlSessionBinding
  /** Control proofs of the peer, required by the verifier. */
  browserProofWire: string
  connectorProofWire: string
  /** Optional transport callbacks. Absent means the peer stays inert. */
  sendPhase?(message: PausePhaseMessage): boolean
  sendResult?(result: PauseResultMessage): boolean
  /** Aborted when the control transport ends. */
  signal?: AbortSignal
}>

export type PauseRelayAdmit =
  | { ok: true }
  | { ok: false; reason: PauseCapabilityRejection | 'unknown-peer' }

export type PauseRelayDiagnostics = Readonly<{
  peers: number
  admitted: number
  commands: number
  rejected: number
  notSent: number
  applied: number
  outcomeUnknown: number
  /** Result frames the transport refused or faulted. The peer never learns. */
  unsentResults: number
  /** Peers sealed by their own deadline, without any traffic. */
  expired: number
  pending: number
  closed: boolean
  lastReason: PauseRelayReason | undefined
}>

export type PauseCommandRelay = Readonly<{
  /**
   * Opens a control peer and starts the admission. Returns `false` when the
   * relay is closed, the peer map is full, the binding or its control proofs do
   * not verify, the assignment is not mapped locally, the local mapping
   * disagrees with the control binding, or the transport refuses the admission
   * nonce. A refused peer is closed, never left half open. A validated peer
   * replaces an older peer of the same transport id only after it is validated.
   */
  openPeer(input: PauseRelayPeerInput): boolean
  /**
   * Admits the issued capability and the browser admission proof. The attempt is
   * single use: repeating it returns the outcome of the first attempt.
   *
   * The two phases arrive as two separate frames, so either half may be
   * delivered first. The verifier token is consumed only once the exact
   * capability and admission proof pair is complete, and never after the
   * admission deadline. A half delivered pair never consumes the token: the
   * peer deadline ends the wait.
   */
  admitPeer(input: {
    transportId: string
    capabilityWire?: string
    admissionProofWire?: string
  }): Promise<PauseRelayAdmit>
  /**
   * Runs the single signed command of a peer and answers with its outcome. A
   * command that arrives while the admission is still running waits for it.
   */
  commandPeer(input: {
    transportId: string
    wire: string
  }): Promise<PauseRelayOutcome>
  /** Trusted local observation publisher. Never sourced from a command or a server. */
  observe(binding: PrinterBinding, observation: unknown): boolean
  /** Ends a peer: the capability is revoked and every later send is sealed. */
  closePeer(transportId: string): void
  /** Terminal for the relay and for the dispatcher it owns. */
  close(): void
  /**
   * Resolves when the relay is closed and every retained asynchronous task
   * actually settled. Before the close it never resolves: the relay can still
   * accept a peer or a command.
   */
  readonly settled: Promise<void>
  diagnostics(): PauseRelayDiagnostics
}>

type Peer = {
  transportId: string
  binding: ControlSessionBinding
  printerBinding: PrinterBinding
  browserProofWire: string
  connectorProofWire: string
  token: PauseAdmissionToken
  nonce: string
  handle: PauseCapabilityHandle | undefined
  publisher: { peer: PausePeerHandle; close(): void }
  controller: AbortController
  sendPhase: (message: PausePhaseMessage) => boolean
  sendResult: (result: PauseResultMessage) => boolean
  sealed: boolean
  command: Promise<PauseRelayOutcome> | undefined
  attempt: Promise<PauseRelayAdmit> | undefined
  resolveAttempt: ((value: PauseRelayAdmit) => void) | undefined
  /** The verifier attempt of this peer already started. */
  work: boolean
  gate: Promise<PauseRelayAdmit>
  resolveGate: (value: PauseRelayAdmit) => void
  /** The two admission halves, buffered until the exact pair is complete. */
  capabilityWire: string | undefined
  admissionProofWire: string | undefined
  /** Monotonic admission deadline. It is never reset by a late half. */
  admissionDeadlineMono: number
  /** Monotonic start of the admission, used for the capability deadline. */
  admissionStartMono: number
  /** Wall start of the admission, used for the capability deadline. */
  admissionStartWall: number
  /** Monotonic capability deadline, armed after a successful admission. */
  capabilityDeadlineMono: number
  expiry: ReturnType<typeof setTimeout> | undefined
  removeAbort: () => void
}

const inert = () => false

/** Hard bounds of the pause policy. The relay never widens them. */
const ADMISSION_MS = PAUSE_POLICY_HARD_MAXIMUMS.admissionMs
const CAPABILITY_MS = PAUSE_POLICY_HARD_MAXIMUMS.capabilityMs

/** Bounded peer map. A peer beyond the cap is refused, never queued. */
export const PAUSE_RELAY_MAX_PEERS = 16
/** Bounded concurrent dispatches. A command beyond the cap is refused. */
export const PAUSE_RELAY_MAX_COMMANDS = 8
/** Bounded retained asynchronous work. */
export const PAUSE_RELAY_MAX_PENDING_WORK = 32

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
 * Library-only composition of one authenticated pause command path. This relay
 * is the exclusive owner of the dispatcher it creates, and that dispatcher is the
 * exclusive owner of the capability verifier. No other module may admit or
 * dispatch against this transport.
 *
 * The relay never talks to Moonraker, to the issuer or to the server. It binds
 * to the existing control transport through optional callbacks that default to
 * inert, so constructing a relay never enables commands anywhere.
 */
export function createPauseCommandRelay(
  config: PauseRelayConfig,
): PauseCommandRelay {
  const bindingFor = config.bindingFor.bind(config)
  const wallNow = config.clock.wallNow.bind(config.clock)
  const monotonicNow = config.clock.monotonicNow.bind(config.clock)
  const dispatcher = createPauseDispatcher({
    authority: { issuers: config.authority.issuers },
    clock: config.clock,
    journal: config.journal,
    driver: config.driver,
  })
  const peers = new Map<string, Peer>()
  const pending = new Set<Promise<unknown>>()
  const waiters = new Set<() => void>()
  let closed = false
  let generation = 0
  let admitted = 0
  let commands = 0
  let rejected = 0
  let notSent = 0
  let applied = 0
  let outcomeUnknown = 0
  let unsentResults = 0
  let expired = 0
  let running = 0
  let lastReason: PauseRelayReason | undefined
  let lastMono = -1
  function sample(): number | undefined {
    let value: number
    try {
      value = monotonicNow()
    } catch {
      return undefined
    }
    // A broken or rewound monotonic clock is never trusted for a deadline.
    if (!Number.isFinite(value) || value < 0 || value < lastMono)
      return undefined
    lastMono = value
    return value
  }
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
    if (!closed || pending.size) return
    for (const waiter of [...waiters]) waiter()
    waiters.clear()
  }
  function seal(peer: Peer): void {
    if (peer.sealed) return
    peer.sealed = true
    peer.removeAbort()
    if (peer.expiry !== undefined) {
      clearTimeout(peer.expiry)
      peer.expiry = undefined
    }
    // Abort first: an in-flight dispatch settles as aborted, never as a late applied.
    peer.controller.abort()
    if (peer.handle) dispatcher.revoke(peer.handle)
    peer.publisher.close()
    peer.resolveGate({ ok: false, reason: 'expired-or-inactive' })
    if (peer.resolveAttempt) {
      const resolve = peer.resolveAttempt
      peer.resolveAttempt = undefined
      resolve({ ok: false, reason: 'expired-or-inactive' })
    }
  }
  function closePeer(transportId: string): void {
    const peer = peers.get(transportId)
    if (!peer) return
    seal(peer)
    peers.delete(transportId)
  }
  function armExpiry(peer: Peer, deadlineMono: number): void {
    if (peer.expiry !== undefined) {
      clearTimeout(peer.expiry)
      peer.expiry = undefined
    }
    const now = sample()
    if (now === undefined || deadlineMono <= now) {
      expired++
      closePeer(peer.transportId)
      return
    }
    peer.expiry = setTimeout(() => {
      peer.expiry = undefined
      expired++
      closePeer(peer.transportId)
    }, deadlineMono - now)
  }
  function deliverResult(
    peer: Peer,
    commandId: string,
    outcome: PauseRelayOutcome,
  ): void {
    // A sealed peer never sends again: the result stays local.
    if (peer.sealed) return
    const state = attemptSend(() =>
      peer.sendResult({
        t: 'control.result',
        command_id: commandId,
        outcome,
      }),
    )
    if (state !== 'sent') {
      // The browser will time out with an unknown outcome. The relay only knows
      // that the frame did not leave through the transport.
      unsentResults++
    }
  }
  async function attemptAdmission(
    peer: Peer,
    capabilityWire: string,
    admissionProofWire: string,
  ): Promise<PauseRelayAdmit> {
    let capability: ReturnType<typeof decodePauseCapability>
    let proof: ReturnType<typeof decodePauseAdmissionProof>
    try {
      capability = decodePauseCapability(capabilityWire)
      proof = decodePauseAdmissionProof(admissionProofWire)
    } catch {
      lastReason = 'invalid-proof'
      peer.resolveGate({ ok: false, reason: 'invalid-proof' })
      seal(peer)
      return { ok: false, reason: 'invalid-proof' }
    }
    // The exact pair belongs to this admission. A foreign half never reaches
    // the verifier, so the single use token is not burned by it.
    if (
      capability.admission_nonce !== peer.nonce ||
      proof.challenge.admission_nonce !== peer.nonce
    ) {
      lastReason = 'scope-mismatch'
      peer.resolveGate({ ok: false, reason: 'scope-mismatch' })
      seal(peer)
      return { ok: false, reason: 'scope-mismatch' }
    }
    const now = sample()
    if (now === undefined || now >= peer.admissionDeadlineMono) {
      lastReason = 'expired-or-inactive'
      seal(peer)
      return { ok: false, reason: 'expired-or-inactive' }
    }
    let decision: Awaited<ReturnType<typeof dispatcher.admit>>
    try {
      decision = await dispatcher.admit(peer.token, {
        capabilityWire,
        browserProofWire: peer.browserProofWire,
        connectorProofWire: peer.connectorProofWire,
        admissionProofWire,
      })
    } catch {
      lastReason = 'expired-or-inactive'
      return { ok: false, reason: 'expired-or-inactive' }
    }
    if (!decision.ok) {
      lastReason = decision.reason
      // The admission token is single use. The peer stays open so a command
      // that is already on the wire still receives an honest rejection.
      peer.resolveGate({ ok: false, reason: decision.reason })
      return { ok: false, reason: decision.reason }
    }
    if (peer.sealed || peers.get(peer.transportId) !== peer) {
      // A late admission never resurrects a sealed or replaced peer.
      dispatcher.revoke(decision.handle)
      return { ok: false, reason: 'expired-or-inactive' }
    }
    peer.handle = decision.handle
    admitted++
    peer.resolveGate({ ok: true })
    const span = Math.min(
      CAPABILITY_MS,
      capability.expires_at - peer.admissionStartWall,
      peer.binding.expires_at - peer.admissionStartWall,
    )
    peer.capabilityDeadlineMono = peer.admissionStartMono + Math.max(0, span)
    armExpiry(peer, peer.capabilityDeadlineMono)
    return { ok: true }
  }
  function admitPeer(input: {
    transportId: string
    capabilityWire?: string
    admissionProofWire?: string
  }): Promise<PauseRelayAdmit> {
    const peer = peers.get(input.transportId)
    if (!peer || peer.sealed)
      return Promise.resolve<PauseRelayAdmit>({
        ok: false,
        reason: 'unknown-peer',
      })
    if (input.capabilityWire !== undefined) {
      if (
        peer.capabilityWire !== undefined &&
        peer.capabilityWire !== input.capabilityWire
      ) {
        // A second, different capability is a broken peer. Fail closed.
        lastReason = 'invalid-admission'
        seal(peer)
        return Promise.resolve<PauseRelayAdmit>({
          ok: false,
          reason: 'invalid-admission',
        })
      }
      peer.capabilityWire = input.capabilityWire
    }
    if (input.admissionProofWire !== undefined) {
      if (
        peer.admissionProofWire !== undefined &&
        peer.admissionProofWire !== input.admissionProofWire
      ) {
        lastReason = 'invalid-admission'
        seal(peer)
        return Promise.resolve<PauseRelayAdmit>({
          ok: false,
          reason: 'invalid-admission',
        })
      }
      peer.admissionProofWire = input.admissionProofWire
    }
    // The attempt is single use. A repeat returns the first outcome.
    if (!peer.attempt) {
      let resolveAttempt!: (value: PauseRelayAdmit) => void
      const attempt = new Promise<PauseRelayAdmit>((resolve) => {
        resolveAttempt = resolve
      })
      peer.attempt = attempt
      peer.resolveAttempt = resolveAttempt
      track(attempt)
    }
    if (pending.size >= PAUSE_RELAY_MAX_PENDING_WORK)
      return Promise.resolve<PauseRelayAdmit>({
        ok: false,
        reason: 'expired-or-inactive',
      })
    const capabilityWire = peer.capabilityWire
    const admissionProofWire = peer.admissionProofWire
    if (!capabilityWire || !admissionProofWire) {
      // Half of the pair. The peer deadline ends the wait and the attempt
      // resolves with the deadline, never consuming the verifier token.
      return peer.attempt
    }
    if (peer.work) return peer.attempt
    peer.work = true
    const work = track(
      attemptAdmission(peer, capabilityWire, admissionProofWire),
    )
    void work.then(
      (result) => {
        if (peer.resolveAttempt) {
          const resolve = peer.resolveAttempt
          peer.resolveAttempt = undefined
          resolve(result)
        }
      },
      () => {
        if (peer.resolveAttempt) {
          const resolve = peer.resolveAttempt
          peer.resolveAttempt = undefined
          resolve({ ok: false, reason: 'expired-or-inactive' })
        }
      },
    )
    return peer.attempt
  }
  async function runCommand(
    peer: Peer,
    wire: string,
    commandId: string,
  ): Promise<PauseRelayOutcome> {
    const decision = await peer.gate
    const handle = peer.handle
    if (!decision.ok || !handle || peer.sealed) {
      rejected++
      deliverResult(peer, commandId, 'rejected')
      return 'rejected'
    }
    commands++
    const result = await dispatcher.dispatch({
      wire,
      capability: handle,
      printerBinding: peer.printerBinding,
      signal: peer.controller.signal,
    })
    const outcome: PauseRelayOutcome = result.kind
    lastReason = result.reason
    if (outcome === 'applied') applied++
    else if (outcome === 'outcome-unknown') outcomeUnknown++
    else if (outcome === 'not-sent') notSent++
    else rejected++
    deliverResult(peer, commandId, outcome)
    return outcome
  }
  function commandPeer(input: {
    transportId: string
    wire: string
  }): Promise<PauseRelayOutcome> {
    const peer = peers.get(input.transportId)
    if (!peer || peer.sealed) return Promise.resolve('rejected')
    // One command per peer. The first outcome is replayed, never re-dispatched.
    if (peer.command) return peer.command
    let commandId: string
    try {
      commandId = decodeCommandV2(input.wire).cmd_id
    } catch {
      // Without a decoded command id there is no correlation for a result frame.
      lastReason = 'invalid-command'
      rejected++
      return Promise.resolve('rejected')
    }
    if (
      running >= PAUSE_RELAY_MAX_COMMANDS ||
      pending.size >= PAUSE_RELAY_MAX_PENDING_WORK
    ) {
      // No wait list. A command beyond the bound is refused, never queued.
      lastReason = 'busy'
      rejected++
      return Promise.resolve('rejected')
    }
    // Reserved before any await: a reentrant command replays this promise.
    let settleCommand!: (outcome: PauseRelayOutcome) => void
    const reserved = new Promise<PauseRelayOutcome>((resolve) => {
      settleCommand = resolve
    })
    peer.command = reserved
    running++
    const work = track(runCommand(peer, input.wire, commandId))
    void work.then(
      (outcome) => {
        running--
        settleCommand(outcome)
      },
      () => {
        running--
        settleCommand('rejected')
      },
    )
    return reserved
  }
  function openPeer(input: PauseRelayPeerInput): boolean {
    if (closed) return false
    let binding: ControlSessionBinding
    try {
      binding = ControlSessionBinding.parse(input.binding)
    } catch {
      return false
    }
    Object.freeze(binding.browser_public_key)
    Object.freeze(binding)
    // The new peer is validated before it replaces an older one of the same
    // transport id. An unverified peer never evicts a live peer.
    let browserProof: ReturnType<typeof decodeControlProof>
    let connectorProof: ReturnType<typeof decodeControlProof>
    try {
      browserProof = decodeControlProof(input.browserProofWire)
      connectorProof = decodeControlProof(input.connectorProofWire)
    } catch {
      return false
    }
    const expected = canonicalize(binding)
    if (
      browserProof.role !== 'browser' ||
      connectorProof.role !== 'connector' ||
      canonicalize(browserProof.binding) !== expected ||
      canonicalize(connectorProof.binding) !== expected
    )
      return false
    // The local mapping is the only source of the printer binding.
    const printerBinding = bindingFor(binding.assignment_id)
    if (!printerBinding) return false
    const mapping = readPrinterBinding(printerBinding)
    if (
      !mapping ||
      mapping.assignment_id !== binding.assignment_id ||
      mapping.farm_id !== binding.farm_id ||
      mapping.agent_id !== binding.agent_id
    )
      return false
    if (peers.size >= PAUSE_RELAY_MAX_PEERS) return false
    if (input.signal?.aborted) return false
    const startMono = sample()
    const startWall = wallNow()
    if (startMono === undefined || !Number.isSafeInteger(startWall))
      return false
    const sendPhase = input.sendPhase ?? inert
    const sendResult = input.sendResult ?? inert
    let publisher: { peer: PausePeerHandle; close(): void } | undefined
    const opened = (() => {
      try {
        publisher = dispatcher.createPeer(++generation)
        const admission = dispatcher.beginAdmission({
          binding,
          printerBinding,
          peer: publisher.peer,
        })
        return {
          token: admission.token,
          challenge: admission.challenge,
        }
      } catch {
        publisher?.close()
        return undefined
      }
    })()
    if (!opened || !publisher) return false
    let resolveGate!: (value: PauseRelayAdmit) => void
    const gate = new Promise<PauseRelayAdmit>((resolve) => {
      resolveGate = resolve
    })
    const peer: Peer = {
      transportId: binding.transport_id,
      binding,
      printerBinding,
      browserProofWire: input.browserProofWire,
      connectorProofWire: input.connectorProofWire,
      token: opened.token,
      nonce: opened.challenge.admissionNonce,
      handle: undefined,
      publisher,
      controller: new AbortController(),
      sendPhase,
      sendResult,
      sealed: false,
      command: undefined,
      attempt: undefined,
      resolveAttempt: undefined,
      work: false,
      gate,
      resolveGate,
      capabilityWire: undefined,
      admissionProofWire: undefined,
      admissionDeadlineMono: startMono + ADMISSION_MS,
      admissionStartMono: startMono,
      admissionStartWall: startWall,
      capabilityDeadlineMono: startMono + ADMISSION_MS,
      expiry: undefined,
      removeAbort: () => {},
    }
    if (input.signal) {
      const signal = input.signal
      const abort = () => closePeer(peer.transportId)
      signal.addEventListener('abort', abort, { once: true })
      peer.removeAbort = () => signal.removeEventListener('abort', abort)
    }
    // A replaced peer keeps no admission, no capability and no pending command.
    closePeer(peer.transportId)
    peers.set(peer.transportId, peer)
    armExpiry(peer, peer.admissionDeadlineMono)
    if (peer.sealed) return false
    const sent = attemptSend(() =>
      peer.sendPhase({
        t: 'control.admission-nonce',
        admission_nonce: opened.challenge.admissionNonce,
        issued_at: opened.challenge.issuedAt,
        expires_at: opened.challenge.expiresAt,
      }),
    )
    if (sent !== 'sent') {
      // The nonce never reached the peer. The peer is closed, never half open.
      closePeer(peer.transportId)
      return false
    }
    return true
  }
  return Object.freeze({
    openPeer,
    admitPeer,
    commandPeer,
    observe(binding: PrinterBinding, observation: unknown): boolean {
      return dispatcher.observe(binding, observation)
    },
    closePeer,
    close(): void {
      if (closed) return
      closed = true
      for (const peer of [...peers.values()]) closePeer(peer.transportId)
      peers.clear()
      dispatcher.close()
      maybeSettled()
    },
    get settled(): Promise<void> {
      if (closed && !pending.size) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.add(resolve))
    },
    diagnostics(): PauseRelayDiagnostics {
      return Object.freeze({
        peers: peers.size,
        admitted,
        commands,
        rejected,
        notSent,
        applied,
        outcomeUnknown,
        unsentResults,
        expired,
        pending: pending.size,
        closed,
        lastReason,
      })
    },
  })
}
