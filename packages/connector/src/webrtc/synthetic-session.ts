/** Synthetic interoperability fixture only. This module grants no printer authority. */
export type Role = 'browser' | 'connector'
export type Scope = {
  session: string
  browserNonce: string
  connectorNonce: string
  browserSpki: string
  connectorSpki: string
}
export type SessionState =
  | { kind: 'pending' }
  | { kind: 'verified' }
  | { kind: 'readonly'; reason: string }
export const encodeHex = (data: ArrayBuffer) =>
  Array.from(new Uint8Array(data), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
export const randomNonce = () =>
  encodeHex(crypto.getRandomValues(new Uint8Array(32)).buffer)
export function decodeHex(text: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(text))
    throw Error('Invalid hexadecimal encoding')
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16))
}
export function dtlsFingerprint(sdp: string) {
  if (sdp.length > 32768) throw Error('SDP limit')
  const values = new Set(
    [...sdp.matchAll(/^a=fingerprint:sha-256 ([0-9a-f:]+)\r?$/gim)].map(
      (match) => match[1]?.toUpperCase(),
    ),
  )
  const value = values.values().next().value
  if (
    values.size !== 1 ||
    !value ||
    !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value)
  )
    throw Error('Missing unique SHA-256 DTLS fingerprint')
  return value
}
export function transcript(
  scope: Scope,
  role: Role,
  localSdp: string,
  remoteSdp: string,
) {
  if (
    ![scope.session, scope.browserNonce, scope.connectorNonce].every((value) =>
      /^[0-9a-f]{64}$/.test(value),
    ) ||
    ![scope.browserSpki, scope.connectorSpki].every((value) =>
      /^302a300506032b6570032100[0-9a-f]{64}$/.test(value),
    )
  )
    throw Error('Invalid synthetic scope')
  const local = dtlsFingerprint(localSdp)
  const remote = dtlsFingerprint(remoteSdp)
  return JSON.stringify([
    'Open3DFarmManager/synthetic-node-rtc/v1',
    scope.session,
    [
      'browser',
      scope.browserSpki,
      scope.browserNonce,
      role === 'browser' ? local : remote,
    ],
    [
      'connector',
      scope.connectorSpki,
      scope.connectorNonce,
      role === 'connector' ? local : remote,
    ],
  ])
}
const signedBytes = (binding: string, role: Role) =>
  new TextEncoder().encode(JSON.stringify([role, binding]))
export const SYNTHETIC_LIMITS = Object.freeze({
  frameBytes: 2048,
  pendingFrames: 8,
  retainedBytes: 32768,
  totalFrames: 1024,
  acceptedSamples: 16,
  rejectedSamples: 8,
  reasonChars: 64,
  observedEvents: 2048,
  authMs: 8000,
  lifetimeMs: 30000,
})
const IDLE = Promise.resolve()
const encoder = new TextEncoder()
type SessionOptions = {
  role: Role
  binding: string
  privateKey: CryptoKey
  remotePublicKey: CryptoKey
  send: (frame: string) => void
  onReadonly?: () => void
  onVerified?: () => void
  waitForTransport?: boolean
  deadlineMs?: number
  lifetimeMs?: number
}
export class SyntheticSession {
  #state: SessionState = { kind: 'pending' }
  get state(): Readonly<SessionState> {
    return { ...this.#state }
  }
  #accepted: string[] = []
  #rejected: string[] = []
  #sentProofs: string[] = []
  get sentProofs() {
    return [...this.#sentProofs]
  }
  #received = 0
  #acceptedTotal = 0
  #admitted = 0
  #proofsReceived = 0
  #proofsSent = 0
  #timer: ReturnType<typeof setTimeout>
  #lifetime: ReturnType<typeof setTimeout>
  #authActive = true
  #lifetimeActive = true
  #queue: string[] = []
  #activeBytes = 0
  #retainedBytes = 0
  #maxPending = 0
  #maxRetainedBytes = 0
  #running = false
  #transportReady: boolean
  #idle = IDLE
  #resolveIdle: (() => void) | undefined
  #options: SessionOptions
  #started = false
  #localProofSent = false
  constructor(options: SessionOptions) {
    this.#options = Object.freeze({ ...options })
    const deadline = options.deadlineMs ?? SYNTHETIC_LIMITS.authMs
    if (!Number.isInteger(deadline) || deadline < 100 || deadline > 10000)
      throw Error('Invalid session deadline')
    const lifetime = options.lifetimeMs ?? SYNTHETIC_LIMITS.lifetimeMs
    if (
      !Number.isInteger(lifetime) ||
      lifetime < 100 ||
      lifetime > SYNTHETIC_LIMITS.lifetimeMs
    )
      throw Error('Invalid fixture lifetime')
    this.#transportReady = !options.waitForTransport
    this.#timer = setTimeout(() => this.readonly('deadline'), deadline)
    this.#lifetime = setTimeout(
      () => this.readonly('fixture-lifetime'),
      lifetime,
    )
  }
  readonly(reason: string) {
    if (this.isReadonly()) return
    this.#state = {
      kind: 'readonly',
      reason: reason.slice(0, SYNTHETIC_LIMITS.reasonChars),
    }
    clearTimeout(this.#timer)
    clearTimeout(this.#lifetime)
    this.#authActive = false
    this.#lifetimeActive = false
    this.#queue.length = 0
    this.#retainedBytes = this.#activeBytes
    if (!this.#running) this.finishBatch()
    this.#options.onReadonly?.()
  }
  activate() {
    if (this.isReadonly() || this.#transportReady) return
    this.#transportReady = true
    this.pump()
  }
  async start() {
    if (this.#started || this.isReadonly() || !this.#transportReady) return
    this.#started = true
    try {
      const signature = encodeHex(
        await crypto.subtle.sign(
          'Ed25519',
          this.#options.privateKey,
          signedBytes(this.#options.binding, this.#options.role),
        ),
      )
      if (this.isReadonly()) return
      const frame = JSON.stringify({ kind: 'proof', signature })
      this.#sentProofs.push(frame)
      this.#options.send(frame)
      this.#proofsSent = 1
      this.#localProofSent = true
      if (this.#state.kind === 'verified') this.sendStatus()
    } catch {
      this.reject('signing-failed')
    }
  }
  /** Admission is synchronous. No input gets its own pending promise or closure. */
  receive(raw: unknown): Promise<void> {
    if (this.isReadonly()) return IDLE
    // Bound code units before allocating a UTF-8 copy, including giant strings.
    if (
      typeof raw !== 'string' ||
      raw.length > SYNTHETIC_LIMITS.frameBytes ||
      encoder.encode(raw).byteLength > SYNTHETIC_LIMITS.frameBytes
    ) {
      this.reject('frame-limit')
      return IDLE
    }
    const size = raw.length * 2 // Conservative retained UTF-16 payload accounting.
    const pending = this.#queue.length + (this.#running ? 1 : 0)
    if (this.#admitted === SYNTHETIC_LIMITS.totalFrames) {
      this.reject('message-budget')
      return IDLE
    }
    if (
      pending === SYNTHETIC_LIMITS.pendingFrames ||
      this.#retainedBytes + size > SYNTHETIC_LIMITS.retainedBytes
    ) {
      this.reject('pending-limit')
      return IDLE
    }
    if (!pending)
      this.#idle = new Promise((resolve) => {
        this.#resolveIdle = resolve
      })
    this.#admitted++
    this.#queue.push(raw)
    this.#retainedBytes += size
    this.#maxPending = Math.max(this.#maxPending, pending + 1)
    this.#maxRetainedBytes = Math.max(
      this.#maxRetainedBytes,
      this.#retainedBytes,
    )
    this.pump()
    return this.#idle
  }
  private pump() {
    if (
      !this.#running &&
      this.#transportReady &&
      this.#queue.length &&
      !this.isReadonly()
    )
      void this.drain()
  }
  private async drain() {
    this.#running = true
    try {
      while (!this.isReadonly() && this.#queue.length) {
        const raw = this.#queue.shift()
        if (raw === undefined) break
        this.#activeBytes = raw.length * 2
        this.#received++
        await this.process(raw)
        this.#retainedBytes -= this.#activeBytes
        this.#activeBytes = 0
      }
    } finally {
      this.#activeBytes = 0
      this.#retainedBytes = 0
      this.#running = false
      this.finishBatch()
    }
  }
  private finishBatch() {
    this.#resolveIdle?.()
    this.#resolveIdle = undefined
    this.#idle = IDLE
  }
  private reject(reason: string) {
    if (this.isReadonly()) return
    if (this.#rejected.length === SYNTHETIC_LIMITS.rejectedSamples)
      this.#rejected.shift()
    this.#rejected.push(reason.slice(0, SYNTHETIC_LIMITS.reasonChars))
    this.readonly(reason)
  }
  private async process(raw: string) {
    try {
      const frame: unknown = JSON.parse(raw)
      if (!frame || typeof frame !== 'object' || !('kind' in frame))
        throw Error('invalid-frame')
      if (frame.kind === 'proof') {
        this.#proofsReceived++
        if (
          this.#state.kind !== 'pending' ||
          !('signature' in frame) ||
          typeof frame.signature !== 'string' ||
          !/^[0-9a-f]{128}$/.test(frame.signature)
        )
          throw Error('invalid-proof')
        const remoteRole =
          this.#options.role === 'browser' ? 'connector' : 'browser'
        const verified = await crypto.subtle.verify(
          'Ed25519',
          this.#options.remotePublicKey,
          decodeHex(frame.signature),
          signedBytes(this.#options.binding, remoteRole),
        )
        if (this.isReadonly()) return
        if (!verified) throw Error('identity-or-transcript')
        this.#state = { kind: 'verified' }
        clearTimeout(this.#timer)
        this.#authActive = false
        this.#options.onVerified?.()
        this.sendStatus()
      } else if (
        frame.kind === 'synthetic-status' &&
        'value' in frame &&
        frame.value === 'fixture-idle' &&
        this.#state.kind === 'verified'
      ) {
        this.#acceptedTotal++
        if (this.#accepted.length === SYNTHETIC_LIMITS.acceptedSamples)
          this.#accepted.shift()
        this.#accepted.push('fixture-idle')
      } else throw Error('synthetic-only')
    } catch (error) {
      this.reject(error instanceof Error ? error.message : 'rejected')
    }
  }
  private isReadonly() {
    return this.#state.kind === 'readonly'
  }
  sendStatus() {
    if (this.#state.kind !== 'verified' || !this.#localProofSent) return false
    try {
      this.#options.send(
        JSON.stringify({ kind: 'synthetic-status', value: 'fixture-idle' }),
      )
      return true
    } catch {
      this.reject('send-failed')
      return false
    }
  }
  snapshot() {
    return {
      state: { ...this.#state },
      accepted: [...this.#accepted],
      rejected: [...this.#rejected],
      received: this.#received,
      resources: {
        authTimer: this.#authActive,
        lifetimeTimer: this.#lifetimeActive,
      },
      acceptedTotal: this.#acceptedTotal,
      proofsSent: this.#proofsSent,
      proofsReceived: this.#proofsReceived,
      work: {
        admitted: this.#admitted,
        pending: this.#queue.length + (this.#running ? 1 : 0),
        retainedBytes: this.#retainedBytes,
        maxPending: this.#maxPending,
        maxRetainedBytes: this.#maxRetainedBytes,
      },
    }
  }
  dispose() {
    this.readonly('disposed')
  }
}
