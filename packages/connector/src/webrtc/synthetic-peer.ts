import { rtcBindAddress } from '../config/rtc.ts'
import { PeerConnection, type DataChannel } from 'node-datachannel'
import {
  SyntheticSession,
  SYNTHETIC_LIMITS,
  transcript,
  dtlsFingerprint,
  type Scope,
} from './synthetic-session.ts'

type PeerOptions = {
  /** Local ICE bind address. Default loopback. */
  bindAddress?: string
  scope: Scope
  privateKey: CryptoKey
  remotePublicKey: CryptoKey
  deadlineMs?: number
  lifetimeMs?: number
}
const ignoreMessage = () => {}

/** Detached local experiment. This adapter is not wired to the Connector CLI. */
export class SyntheticConnectorPeer {
  readonly peer: PeerConnection
  readonly channel: DataChannel
  #session: SyntheticSession | undefined
  #terminal: string | undefined
  get session() {
    return this.#session
  }
  #options: PeerOptions
  #gathered: Promise<void>
  #resolveGathered: () => void = () => {}
  #actualRemote: string | undefined
  #fingerprintMatches = false
  #received = 0
  #sent = 0
  #proofsSent = 0
  #proofsReceived = 0
  #offered = false
  #opened = false
  #starting = false
  #closeCount = 0
  #transportStates: string[] = []
  #answerPhases: string[] = []
  #authTimer: ReturnType<typeof setTimeout> | undefined
  #lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  constructor(options: PeerOptions) {
    const deadline = options.deadlineMs ?? SYNTHETIC_LIMITS.authMs
    if (!Number.isInteger(deadline) || deadline < 100 || deadline > 10000)
      throw Error('Invalid adapter deadline')
    const lifetime = options.lifetimeMs ?? SYNTHETIC_LIMITS.lifetimeMs
    if (
      !Number.isInteger(lifetime) ||
      lifetime < 100 ||
      lifetime > SYNTHETIC_LIMITS.lifetimeMs
    )
      throw Error('Invalid fixture lifetime')
    this.#options = Object.freeze({
      ...options,
      scope: Object.freeze({ ...options.scope }),
    })
    this.peer = new PeerConnection('synthetic-connector', {
      iceServers: [],
      bindAddress: rtcBindAddress(options.bindAddress),
      enableIceTcp: false,
      disableAutoNegotiation: true,
      maxMessageSize: SYNTHETIC_LIMITS.frameBytes,
      disableFingerprintVerification: false,
    })
    this.#gathered = new Promise((resolve) => {
      this.#resolveGathered = resolve
    })
    this.channel = this.peer.createDataChannel('synthetic-node-v1', {
      unordered: false,
    })
    this.#authTimer = setTimeout(() => this.terminal('deadline'), deadline)
    this.#lifetimeTimer = setTimeout(
      () => this.terminal('fixture-lifetime'),
      lifetime,
    )
    this.peer.onGatheringStateChange((state) => {
      if (!this.#terminal && state === 'complete') this.#resolveGathered()
    })
    this.peer.onStateChange((state) => {
      if (this.#terminal) return
      if (this.#transportStates.length < 16) this.#transportStates.push(state)
      if (state === 'failed' || state === 'closed' || state === 'disconnected')
        this.terminal('transport-' + state)
    })
    this.channel.onOpen(() => {
      if (this.#terminal) return
      this.#opened = true
      this.startTransport()
    })
    this.channel.onMessage((raw) => {
      if (this.#terminal) return
      this.#received = Math.min(
        this.#received + 1,
        SYNTHETIC_LIMITS.observedEvents,
      )
      if (!this.#session) {
        this.terminal('unverified-certificate')
        return
      }
      if (
        typeof raw === 'string' &&
        raw.length <= SYNTHETIC_LIMITS.frameBytes &&
        raw.startsWith('{"kind":"proof"')
      )
        this.#proofsReceived = Math.min(
          this.#proofsReceived + 1,
          SYNTHETIC_LIMITS.observedEvents,
        )
      void this.#session.receive(raw)
    })
    this.channel.onClosed(() => this.terminal('channel-closed'))
    this.channel.onError(() => this.terminal('channel-error'))
  }
  private startTransport() {
    if (this.#terminal || !this.#session || !this.#opened || this.#starting)
      return
    this.#starting = true
    try {
      const actual = this.peer.remoteFingerprint(),
        remote = this.peer.remoteDescription()
      this.#actualRemote = actual.value.toUpperCase()
      this.#fingerprintMatches =
        actual.algorithm === 'sha-256' &&
        !!remote &&
        this.#actualRemote === dtlsFingerprint(remote.sdp)
      if (!this.#fingerprintMatches) {
        this.terminal('actual-certificate-mismatch')
        return
      }
      this.#session.activate()
      void this.#session.start()
    } catch {
      this.terminal('actual-certificate-unavailable')
    }
  }
  private terminal(reason: string) {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, SYNTHETIC_LIMITS.reasonChars)
    clearTimeout(this.#authTimer)
    this.#authTimer = undefined
    clearTimeout(this.#lifetimeTimer)
    this.#lifetimeTimer = undefined
    this.channel.onMessage(ignoreMessage)
    this.#session?.readonly(this.#terminal)
    this.#resolveGathered()
    this.#closeCount++
    try {
      this.channel.close()
    } finally {
      this.peer.close()
    }
  }
  async offer() {
    if (this.#terminal || this.#offered) throw Error('Adapter terminal')
    this.#offered = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      this.peer.setLocalDescription('offer')
      await Promise.race([
        this.#gathered,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Native ICE deadline')), 3000)
        }),
      ])
      if (this.#terminal) throw Error('Adapter terminal')
      const local = this.peer.localDescription()
      if (!local) throw Error('Native offer missing')
      return { type: 'offer', sdp: local.sdp } satisfies {
        type: 'offer'
        sdp: string
      }
    } catch (error) {
      this.terminal('local-description-failed')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  async answer(sdp: string) {
    if (this.#terminal || this.#session || this.peer.state() === 'closed')
      throw Error('Adapter terminal')
    try {
      if (sdp.length > 32768) throw Error('SDP limit')
      this.#answerPhases.push('before:' + this.peer.state())
      this.peer.setRemoteDescription(sdp, 'answer')
      this.#answerPhases.push('after:' + this.peer.state())
      const local = this.peer.localDescription(),
        remote = this.peer.remoteDescription()
      if (!local || !remote)
        throw Error('Native negotiated descriptions missing')
      this.#session = new SyntheticSession({
        role: 'connector',
        binding: transcript(
          this.#options.scope,
          'connector',
          local.sdp,
          remote.sdp,
        ),
        privateKey: this.#options.privateKey,
        remotePublicKey: this.#options.remotePublicKey,
        waitForTransport: true,
        send: (frame) => {
          if (
            this.#terminal ||
            !this.#fingerprintMatches ||
            !this.channel.sendMessage(frame)
          )
            throw Error('Native channel send failed')
          this.#sent = Math.min(this.#sent + 1, SYNTHETIC_LIMITS.observedEvents)
          if (frame.startsWith('{"kind":"proof"'))
            this.#proofsSent = Math.min(
              this.#proofsSent + 1,
              SYNTHETIC_LIMITS.observedEvents,
            )
        },
        onVerified: () => {
          clearTimeout(this.#authTimer)
          this.#authTimer = undefined
        },
        onReadonly: () => {
          const state = this.#session?.state
          this.terminal(
            state?.kind === 'readonly' ? state.reason : 'session-readonly',
          )
        },
        ...(this.#options.deadlineMs === undefined
          ? {}
          : { deadlineMs: this.#options.deadlineMs }),
      })
      if (this.#terminal) this.#session.readonly(this.#terminal)
      this.startTransport()
    } catch (error) {
      if (this.#answerPhases.length < 3)
        this.#answerPhases.push('error:' + this.peer.state())
      this.terminal('remote-description-failed')
      throw Error(
        'Native answer rejected: ' +
          (error instanceof Error ? error.message : 'unknown'),
      )
    }
  }
  snapshot() {
    const pair = this.peer.getSelectedCandidatePair(),
      remote = this.peer.remoteDescription()
    return {
      ...(this.#session?.snapshot() ?? {
        state: this.#terminal
          ? { kind: 'readonly', reason: this.#terminal }
          : { kind: 'pending' },
        accepted: [],
        rejected: [],
        received: 0,
      }),
      connection: this.peer.state(),
      transportStates: [...this.#transportStates],
      answerPhases: [...this.#answerPhases],
      actualRemoteFingerprint: this.#actualRemote,
      expectedRemoteFingerprint: remote
        ? dtlsFingerprint(remote.sdp)
        : undefined,
      fingerprintMatches: this.#fingerprintMatches,
      candidates: pair
        ? {
            local: pair.local.type,
            remote: pair.remote.type,
            localPort: pair.local.port,
          }
        : null,
      iceServers: [],
      channel: this.channel.isOpen() ? 'open' : 'closed',
      sent: this.#sent,
      receivedRtc: this.#received,
      rtcProofsSent: this.#proofsSent,
      rtcProofsReceived: this.#proofsReceived,
      resources: {
        closeCount: this.#closeCount,
        receiveEnabled: !this.#terminal,
        authTimer: this.#authTimer !== undefined,
        lifetimeTimer: this.#lifetimeTimer !== undefined,
      },
    }
  }
  async close() {
    this.terminal('transport-closed')
  }
}
