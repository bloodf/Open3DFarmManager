import { decodeCommandV2 } from '../../../farm-protocol/src/command-v2.ts'
import { ControlSessionBinding } from '../../../farm-protocol/src/control-session-binding.ts'
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
  pending: number
  closed: boolean
  lastReason: PauseDispatchReason | undefined
}>

export type PauseCommandRelay = Readonly<{
  /**
   * Opens a control peer and starts the admission. Returns `false` when the
   * relay is closed, the assignment is not mapped locally, the local mapping
   * disagrees with the control binding, or the transport refuses the admission
   * nonce. A refused peer is closed, never left half open.
   */
  openPeer(input: PauseRelayPeerInput): boolean
  /**
   * Admits the issued capability and the browser admission proof. The attempt is
   * single use: repeating it returns the outcome of the first attempt.
   */
  admitPeer(input: {
    transportId: string
    capabilityWire: string
    admissionProofWire: string
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
  /** Resolves when the retained asynchronous work actually settled. */
  readonly settled: Promise<void>
  diagnostics(): PauseRelayDiagnostics
}>

type Peer = {
  transportId: string
  printerBinding: PrinterBinding
  browserProofWire: string
  connectorProofWire: string
  token: PauseAdmissionToken
  handle: PauseCapabilityHandle | undefined
  publisher: { peer: PausePeerHandle; close(): void }
  controller: AbortController
  sendPhase: (message: PausePhaseMessage) => boolean
  sendResult: (result: PauseResultMessage) => boolean
  sealed: boolean
  command: Promise<PauseRelayOutcome> | undefined
  attempt: Promise<PauseRelayAdmit> | undefined
  gate: Promise<PauseRelayAdmit>
  resolveGate: (value: PauseRelayAdmit) => void
  admissionExpiresAt: number
  removeAbort: () => void
}

const inert = () => false
const MAX_ADMISSION_WAIT_MS = 8000

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
  let lastReason: PauseDispatchReason | undefined
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
  function seal(peer: Peer): void {
    if (peer.sealed) return
    peer.sealed = true
    peer.removeAbort()
    // Abort first: an in-flight dispatch settles as aborted, never as a late applied.
    peer.controller.abort()
    if (peer.handle) dispatcher.revoke(peer.handle)
    peer.publisher.close()
    peer.resolveGate({ ok: false, reason: 'expired-or-inactive' })
  }
  function closePeer(transportId: string): void {
    const peer = peers.get(transportId)
    if (!peer) return
    seal(peer)
    peers.delete(transportId)
  }
  async function awaitAdmission(peer: Peer): Promise<PauseRelayAdmit> {
    const remaining = Math.min(
      MAX_ADMISSION_WAIT_MS,
      Math.max(0, peer.admissionExpiresAt - wallNow()),
    )
    if (remaining <= 0) return { ok: false, reason: 'expired-or-inactive' }
    const expiry = new Promise<PauseRelayAdmit>((resolve) => {
      const signal = AbortSignal.timeout(remaining)
      signal.addEventListener(
        'abort',
        () => resolve({ ok: false, reason: 'expired-or-inactive' }),
        { once: true },
      )
    })
    return Promise.race([peer.gate, expiry])
  }
  function openPeer(input: PauseRelayPeerInput): boolean {
    if (closed) return false
    let binding: ControlSessionBinding
    try {
      binding = ControlSessionBinding.parse(input.binding)
    } catch {
      return false
    }
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
    const sendPhase = input.sendPhase ?? inert
    const sendResult = input.sendResult ?? inert
    // A replaced peer keeps no admission, no capability and no pending command.
    closePeer(binding.transport_id)
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
      printerBinding,
      browserProofWire: input.browserProofWire,
      connectorProofWire: input.connectorProofWire,
      token: opened.token,
      handle: undefined,
      publisher,
      controller: new AbortController(),
      sendPhase,
      sendResult,
      sealed: false,
      command: undefined,
      attempt: undefined,
      gate,
      resolveGate,
      admissionExpiresAt: opened.challenge.expiresAt,
      removeAbort: () => {},
    }
    if (input.signal) {
      const signal = input.signal
      const abort = () => closePeer(peer.transportId)
      signal.addEventListener('abort', abort, { once: true })
      peer.removeAbort = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
    }
    peers.set(peer.transportId, peer)
    const sent = peer.sendPhase({
      t: 'control.admission-nonce',
      admission_nonce: opened.challenge.admissionNonce,
      issued_at: opened.challenge.issuedAt,
      expires_at: opened.challenge.expiresAt,
    })
    if (!sent) {
      closePeer(peer.transportId)
      return false
    }
    return true
  }
  function admitPeer(input: {
    transportId: string
    capabilityWire: string
    admissionProofWire: string
  }): Promise<PauseRelayAdmit> {
    const peer = peers.get(input.transportId)
    if (!peer || peer.sealed)
      return Promise.resolve<PauseRelayAdmit>({
        ok: false,
        reason: 'unknown-peer',
      })
    if (peer.handle) return Promise.resolve<PauseRelayAdmit>({ ok: true })
    if (peer.attempt) return peer.attempt
    const attempt = track(
      dispatcher
        .admit(peer.token, {
          capabilityWire: input.capabilityWire,
          browserProofWire: peer.browserProofWire,
          connectorProofWire: peer.connectorProofWire,
          admissionProofWire: input.admissionProofWire,
        })
        .then((decision): PauseRelayAdmit => {
          if (!decision.ok) {
            // The admission token is single use. The peer stays open so a command
            // that is already on the wire still receives an honest rejection.
            peer.resolveGate({ ok: false, reason: decision.reason })
            return { ok: false, reason: decision.reason }
          }
          peer.handle = decision.handle
          admitted++
          peer.resolveGate({ ok: true })
          return { ok: true }
        }),
    )
    peer.attempt = attempt
    return attempt
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
    const work = track(
      (async (): Promise<PauseRelayOutcome> => {
        const decision = await awaitAdmission(peer)
        const handle = peer.handle
        if (!decision.ok || !handle) {
          const outcome: PauseRelayOutcome = 'rejected'
          rejected++
          if (!peer.sealed)
            peer.sendResult({
              t: 'control.result',
              command_id: commandId,
              outcome,
            })
          return outcome
        }
        commands++
        const result = await dispatcher.dispatch({
          wire: input.wire,
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
        // A sealed peer never sends again: the result stays local.
        if (!peer.sealed)
          peer.sendResult({
            t: 'control.result',
            command_id: commandId,
            outcome,
          })
        return outcome
      })(),
    )
    peer.command = work
    return work
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
    },
    get settled(): Promise<void> {
      if (!pending.size) return Promise.resolve()
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
        pending: pending.size,
        closed,
        lastReason,
      })
    },
  })
}
