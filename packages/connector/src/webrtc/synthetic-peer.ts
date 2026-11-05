import { PeerConnection, type DataChannel } from 'node-datachannel'
import {
  SyntheticSession,
  transcript,
  dtlsFingerprint,
  type Scope,
} from './synthetic-session.ts'

type PeerOptions = {
  scope: Scope
  privateKey: CryptoKey
  remotePublicKey: CryptoKey
  deadlineMs?: number
}

/** Detached local experiment. This adapter is not wired to the Connector CLI. */
export class SyntheticConnectorPeer {
  readonly peer = new PeerConnection('synthetic-connector', {
    iceServers: [],
    bindAddress: '127.0.0.1',
    enableIceTcp: false,
    disableAutoNegotiation: true,
    maxMessageSize: 2048,
    // Keep native certificate verification enabled. Never override this in fixtures.
    disableFingerprintVerification: false,
  })
  readonly channel: DataChannel
  #session: SyntheticSession | undefined
  #terminal: string | undefined
  get session() {
    return this.#session
  }
  #options: PeerOptions
  #ready: Promise<void>
  #resolveReady: () => void = () => {}
  #gathered: Promise<void>
  #resolveGathered: () => void = () => {}
  #actualRemote: string | undefined
  #fingerprintMatches = false
  #received = 0
  #sent = 0
  #offered = false
  #transportStates: string[] = []
  #answerPhases: string[] = []
  constructor(options: PeerOptions) {
    this.#options = Object.freeze({
      ...options,
      scope: Object.freeze({ ...options.scope }),
    })
    this.#ready = new Promise((resolve) => {
      this.#resolveReady = resolve
    })
    this.#gathered = new Promise((resolve) => {
      this.#resolveGathered = resolve
    })
    this.peer.onGatheringStateChange((state) => {
      if (state === 'complete') this.#resolveGathered()
    })
    this.peer.onStateChange((state) => {
      if (this.#transportStates.length < 16) this.#transportStates.push(state)
      if (state === 'failed' || state === 'closed' || state === 'disconnected')
        this.terminal('transport-' + state)
    })
    this.channel = this.peer.createDataChannel('synthetic-node-v1', {
      unordered: false,
    })
    this.channel.onOpen(() => {
      void this.#ready.then(async () => {
        try {
          const actual = this.peer.remoteFingerprint()
          const remote = this.peer.remoteDescription()
          this.#actualRemote = actual.value.toUpperCase()
          this.#fingerprintMatches =
            actual.algorithm === 'sha-256' &&
            !!remote &&
            this.#actualRemote === dtlsFingerprint(remote.sdp)
          if (!this.#fingerprintMatches) {
            this.#session?.readonly('actual-certificate-mismatch')
            return
          }
          await this.#session?.start()
        } catch {
          this.#session?.readonly('actual-certificate-unavailable')
        }
      })
    })
    this.channel.onMessage((raw) => {
      this.#received++
      void this.#ready.then(() => {
        if (!this.#fingerprintMatches) {
          this.#session?.readonly('unverified-certificate')
          return
        }
        return this.#session?.receive(raw)
      })
    })
    this.channel.onClosed(() => this.terminal('channel-closed'))
    this.channel.onError(() => this.terminal('channel-error'))
  }
  private terminal(reason: string) {
    this.#terminal ??= reason
    this.#session?.readonly(this.#terminal)
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
      const local = this.peer.localDescription()
      if (!local) throw Error('Native offer missing')
      return { type: 'offer', sdp: local.sdp } satisfies {
        type: 'offer'
        sdp: string
      }
    } catch (error) {
      this.terminal('local-description-failed')
      this.peer.close()
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
        send: (frame) => {
          if (!this.#fingerprintMatches || !this.channel.sendMessage(frame))
            throw Error('Native channel send failed')
          this.#sent++
        },
        onReadonly: () => {
          this.#terminal ??= 'session-readonly'
          this.channel.close()
        },
        ...(this.#options.deadlineMs === undefined
          ? {}
          : { deadlineMs: this.#options.deadlineMs }),
      })
      if (this.#terminal) this.#session.readonly(this.#terminal)
      this.#resolveReady()
    } catch (error) {
      this.#answerPhases.push('error:' + this.peer.state())
      this.terminal('remote-description-failed')
      this.#resolveReady()
      this.peer.close()
      throw Error(
        'Native answer rejected: ' +
          (error instanceof Error ? error.message : 'unknown'),
      )
    }
  }

  snapshot() {
    const pair = this.peer.getSelectedCandidatePair()
    const remote = this.peer.remoteDescription()
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
    }
  }
  async close() {
    this.terminal('transport-closed')
    this.#resolveReady()
    this.#resolveGathered()
    this.peer.close()
  }
}
