import { BoundedReceive } from './bounded-receive.ts'

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
  #proofsReceived = 0
  #proofsSent = 0
  #timer: ReturnType<typeof setTimeout>
  #lifetime: ReturnType<typeof setTimeout>
  #authActive = true
  #lifetimeActive = true
  #receive: BoundedReceive
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
    this.#receive = new BoundedReceive({
      limits: SYNTHETIC_LIMITS,
      paused: Boolean(options.waitForTransport),
      process: async (raw) => {
        this.#received++
        await this.process(raw)
      },
      reject: (reason) => this.reject(reason),
    })
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
    this.#receive.close()
    this.#options.onReadonly?.()
  }
  activate() {
    this.#receive.activate()
  }
  async start() {
    if (this.#started || this.isReadonly() || !this.#receive.ready) return
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
    return this.#receive.receive(raw)
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
      work: this.#receive.snapshot(),
    }
  }
  dispose() {
    this.readonly('disposed')
  }
}
