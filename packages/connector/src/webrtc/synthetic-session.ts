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
type SessionOptions = {
  role: Role
  binding: string
  privateKey: CryptoKey
  remotePublicKey: CryptoKey
  send: (frame: string) => void
  onReadonly?: () => void
  deadlineMs?: number
}
export class SyntheticSession {
  #state: SessionState = { kind: 'pending' }
  get state(): Readonly<SessionState> {
    return { ...this.#state }
  }
  readonly accepted: string[] = []
  readonly rejected: string[] = []
  readonly sentProofs: string[] = []
  received = 0
  #timer: ReturnType<typeof setTimeout>
  #queue = Promise.resolve()
  #options: SessionOptions
  #started = false
  #localProofSent = false
  constructor(options: SessionOptions) {
    this.#options = Object.freeze({ ...options })
    const deadline = options.deadlineMs ?? 8000
    if (!Number.isInteger(deadline) || deadline < 100 || deadline > 10000)
      throw Error('Invalid session deadline')
    this.#timer = setTimeout(() => this.readonly('deadline'), deadline)
  }
  readonly(reason: string) {
    const first = this.#state.kind !== 'readonly'
    if (first) this.#state = { kind: 'readonly', reason }
    clearTimeout(this.#timer)
    if (first) this.#options.onReadonly?.()
  }
  async start() {
    if (this.#started || this.#state.kind === 'readonly') return
    this.#started = true
    try {
      const signature = encodeHex(
        await crypto.subtle.sign(
          'Ed25519',
          this.#options.privateKey,
          signedBytes(this.#options.binding, this.#options.role),
        ),
      )
      const frame = JSON.stringify({ kind: 'proof', signature })
      this.sentProofs.push(frame)
      if (!this.isReadonly()) {
        this.#options.send(frame)
        this.#localProofSent = true
        if (this.#state.kind === 'verified') this.sendStatus()
      }
    } catch {
      this.readonly('signing-failed')
    }
  }
  receive(raw: unknown) {
    this.#queue = this.#queue.then(async () => {
      this.received++
      try {
        if (this.#state.kind === 'readonly') throw Error('readonly')
        if (typeof raw !== 'string' || raw.length > 2048)
          throw Error('frame-limit')
        const frame: unknown = JSON.parse(raw)
        if (!frame || typeof frame !== 'object' || !('kind' in frame))
          throw Error('invalid-frame')
        if (frame.kind === 'proof') {
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
          // The deadline or transport close may fire while crypto is pending.
          if (this.isReadonly() || !verified)
            throw Error('identity-or-transcript')
          this.#state = { kind: 'verified' }
          clearTimeout(this.#timer)
          this.sendStatus()
        } else if (
          frame.kind === 'synthetic-status' &&
          'value' in frame &&
          frame.value === 'fixture-idle' &&
          this.#state.kind === 'verified'
        ) {
          this.accepted.push(frame.value)
        } else throw Error('synthetic-only')
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'rejected'
        this.rejected.push(reason)
        this.readonly(reason)
      }
    })
    return this.#queue
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
      this.readonly('send-failed')
      return false
    }
  }
  snapshot() {
    return {
      state: { ...this.#state },
      accepted: [...this.accepted],
      rejected: [...this.rejected],
      received: this.received,
    }
  }
  dispose() {
    this.readonly('disposed')
  }
}
