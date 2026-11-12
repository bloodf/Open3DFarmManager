import type {
  PauseCommandOutcome,
  PauseProofsReady,
} from '../../../../../packages/connector/src/webrtc/pause-control-session.ts'
import { PauseBrowserSignallingClient } from './pause-signalling-client.ts'
import {
  createPauseCommandClient,
  type PauseCommandIssuer,
} from './pause-command-client.ts'
import { createPauseCommandIssuer } from './pause-command-issuer.ts'

/** A capability with less validity than this is never offered for a pause. */
export const PAUSE_CAPABILITY_MARGIN_MS = 3000

export type FarmPauseControlState =
  | { kind: 'connecting' }
  /** Admitted peer with a fresh signed capability, valid until `expiresAt` (wall). */
  | { kind: 'ready'; expiresAt: number }
  | { kind: 'sending' }
  | { kind: 'settled'; outcome: PauseCommandOutcome }
  | { kind: 'failed'; reason: FarmPauseFailure }

/** `not-ready`: no fresh capability in time, often a wrong device clock. */
export type FarmPauseFailure =
  'unavailable' | 'not-ready' | 'expired' | 'closed'

/** A session that is not ready by then fails closed. */
export const PAUSE_READY_DEADLINE_MS = 15_000

export type FarmPauseKey = Readonly<{
  publicKey: unknown
  privateKey: CryptoKey
  /** Pause metadata: same-origin HTTPS origin and pause audience. */
  origin: string
  audience: string
}>

type Signalling = Pick<
  PauseBrowserSignallingClient,
  'start' | 'close' | 'dispose' | 'sendPhase' | 'sendCommand'
>
type SignallingOptions = NonNullable<
  ConstructorParameters<typeof PauseBrowserSignallingClient>[1]
>

export type FarmPauseControlInput = Readonly<{
  accountId: string
  farmId: string
  keyId: string
  agentId: string
  assignmentId: string
  /** Resolves the approved local key and the pause metadata, or throws. */
  resolveKey(signal: AbortSignal): Promise<FarmPauseKey>
  onState(state: FarmPauseControlState): void
  now?: () => number
  /** Test seams; production uses the maintained clients. */
  createSignalling?: (
    scope: ConstructorParameters<typeof PauseBrowserSignallingClient>[0],
    options: SignallingOptions,
  ) => Signalling
  issuer?: PauseCommandIssuer
}>

/**
 * One pause control session for one assignment: authenticated pause RTC,
 * issued capability, then at most one signed command over the data channel.
 * Nothing is sent over HTTP except the capability issuance, and nothing is
 * ever retried. Closing ends the session; a new pause needs a new session.
 */
export function openFarmPauseControl(input: FarmPauseControlInput) {
  const now = input.now ?? Date.now
  const controller = new AbortController()
  let state: FarmPauseControlState = { kind: 'connecting' }
  let signalling: Signalling | undefined
  let command: ReturnType<typeof createPauseCommandClient> | undefined
  let capabilityExpiresAt: number | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let disposed: Promise<void> | undefined
  function set(next: FarmPauseControlState) {
    // A settled outcome or failure is final for this session.
    if (state.kind === 'settled' || state.kind === 'failed') return
    state = next
    try {
      input.onState(next)
    } catch {
      // Rendering never changes the command path.
    }
  }
  function fail(reason: FarmPauseFailure) {
    if (state.kind === 'sending') return
    set({ kind: 'failed', reason })
    close()
  }
  const readyDeadline = setTimeout(() => {
    if (state.kind === 'connecting') fail('not-ready')
  }, PAUSE_READY_DEADLINE_MS)
  function close() {
    clearTimeout(readyDeadline)
    clearTimeout(expiry)
    controller.abort()
    command?.abort()
    signalling?.close()
  }
  const baseIssuer = input.issuer ?? createPauseCommandIssuer()
  const issuer: PauseCommandIssuer = Object.freeze({
    challenge: (value) => baseIssuer.challenge(value),
    async capability(value) {
      const issued = await baseIssuer.capability(value)
      capabilityExpiresAt = issued.expires_at
      return issued
    },
  })
  async function start() {
    let key: FarmPauseKey
    try {
      key = await input.resolveKey(controller.signal)
    } catch {
      fail('unavailable')
      return
    }
    if (controller.signal.aborted) return
    command = createPauseCommandClient({
      privateKey: key.privateKey,
      issuer,
      signal: controller.signal,
      transport: {
        sendPhase(message) {
          const sent = signalling?.sendPhase(message) ?? false
          if (sent && message.t === 'control.admission-proof') admitted()
          return sent
        },
        sendCommand: (message) => signalling?.sendCommand(message) ?? false,
      },
      onOutcome: (outcome) => set({ kind: 'settled', outcome }),
    })
    const create =
      input.createSignalling ??
      ((scope, options) => new PauseBrowserSignallingClient(scope, options))
    try {
      signalling = create(
        {
          accountId: input.accountId,
          farmId: input.farmId,
          origin: key.origin,
          audience: key.audience,
          keyId: input.keyId,
          agentId: input.agentId,
          assignmentId: input.assignmentId,
          publicKey: key.publicKey,
          privateKey: key.privateKey,
        },
        {
          signal: controller.signal,
          onProofsReady: (ready: PauseProofsReady) =>
            command?.proofsReady(ready),
          onPhase: (frame) => command?.phase(frame),
          onData: (frame) => command?.data(frame),
          onTerminal: () => fail('closed'),
        },
      )
    } catch {
      fail('unavailable')
      return
    }
    void signalling.start().catch(() => fail('unavailable'))
  }
  function admitted() {
    const expiresAt = capabilityExpiresAt
    const remaining =
      expiresAt === undefined
        ? 0
        : expiresAt - PAUSE_CAPABILITY_MARGIN_MS - now()
    if (remaining <= 0) {
      // A capability already expired by this device's clock was never usable.
      fail('not-ready')
      return
    }
    // Defer: this runs inside the transport callback of the command client.
    queueMicrotask(() => {
      if (state.kind !== 'connecting') return
      clearTimeout(readyDeadline)
      set({ kind: 'ready', expiresAt: expiresAt! })
      expiry = setTimeout(() => {
        if (state.kind === 'ready') fail('expired')
      }, remaining)
    })
  }
  void start()
  return Object.freeze({
    /** Sends the single signed pause. Only valid in the `ready` state. */
    async pause(): Promise<PauseCommandOutcome | undefined> {
      if (state.kind !== 'ready' || !command) return undefined
      if (now() >= state.expiresAt - PAUSE_CAPABILITY_MARGIN_MS) {
        fail('expired')
        return undefined
      }
      clearTimeout(expiry)
      set({ kind: 'sending' })
      const outcome = await command.pause()
      set({ kind: 'settled', outcome })
      close()
      return outcome
    },
    close() {
      if (state.kind === 'connecting' || state.kind === 'ready') fail('closed')
      else close()
    },
    /** Resolves once the transport and the command client actually settled. */
    dispose(): Promise<void> {
      close()
      disposed ??= Promise.allSettled([
        command?.settled,
        signalling?.dispose(3000),
      ]).then(() => {})
      return disposed
    },
  })
}
export type FarmPauseControl = ReturnType<typeof openFarmPauseControl>
