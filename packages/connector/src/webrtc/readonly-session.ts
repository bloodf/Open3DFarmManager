import {
  RtcSessionBinding,
  type RtcPeerRole,
  encodeRtcProof,
  verifyExpectedRtcProof,
  decodeRtcProof,
} from '../../../farm-protocol/src/rtc-session-binding.ts'
import { boundRtcApplicationFrame } from './rtc-proof-inbox.ts'

/** Local interoperability observation only. No executable command or media. */
export const READONLY_FIXTURE_STATUS =
  '{"kind":"readonly-status","value":"fixture-idle"}'
type Options = {
  binding: unknown
  role: RtcPeerRole
  authDeadline: number
  lifetimeDeadline: number
  signProof: (binding: RtcSessionBinding) => unknown | Promise<unknown>
  sendProof: (wire: string) => void
  sendApplication: (wire: string) => void
  onVerified: () => void
  onReadonly: () => void
}
/** Role-proof session after the adapter has checked actual DTLS certificates.
 * Trusted binding admission and role proof do not establish registry enrollment,
 * current server authorization, a camera lease or printer-command authority.
 */
export class ReadonlyRtcSession {
  #options: Readonly<Options>
  #binding: RtcSessionBinding
  #state: 'pending' | 'verified' | 'readonly' = 'pending'
  #reason = ''
  #localProof = false
  #remoteProof = false
  #remoteVerified = false
  #started = false
  #accepted = 0
  #acceptedSamples: string[] = []
  #leaseDeadline: number
  #timer: ReturnType<typeof setTimeout>
  constructor(options: Options) {
    this.#options = Object.freeze({ ...options })
    this.#binding = RtcSessionBinding.parse(options.binding)
    Object.freeze(this.#binding.browser_public_key)
    Object.freeze(this.#binding)
    const remaining = this.#binding.expires_at - Date.now()
    this.#leaseDeadline = Math.min(
      performance.now() + remaining,
      options.lifetimeDeadline,
    )
    this.#timer = setTimeout(() => this.close('deadline'), 0)
    this.schedule()
    if (Date.now() < this.#binding.issued_at || remaining <= 0)
      this.close('binding-expired')
  }
  private current() {
    if (this.#state === 'readonly') return false
    if (
      performance.now() >= this.#leaseDeadline ||
      (this.#state === 'pending' &&
        performance.now() >= this.#options.authDeadline) ||
      Date.now() < this.#binding.issued_at ||
      Date.now() >= this.#binding.expires_at
    ) {
      this.close('deadline')
      return false
    }
    return true
  }
  private schedule() {
    clearTimeout(this.#timer)
    const end =
      this.#state === 'pending'
        ? Math.min(this.#leaseDeadline, this.#options.authDeadline)
        : this.#leaseDeadline
    this.#timer = setTimeout(
      () => this.close('deadline'),
      Math.max(0, end - performance.now()),
    )
  }
  async start() {
    if (this.#started || !this.current()) return
    this.#started = true
    try {
      const proof = await this.#options.signProof(this.#binding)
      if (!this.current()) return
      const wire = encodeRtcProof(proof)
      if (
        !(await verifyExpectedRtcProof(this.#binding, this.#options.role, wire))
      ) {
        this.close('local-proof')
        return
      }
      if (!this.current()) return
      this.#options.sendProof(wire)
      this.#localProof = true
      this.finishVerification()
    } catch {
      this.close('local-proof')
    }
  }
  /** Called only by the adapter's bounded canonical proof inbox. */
  async inspectProof(proof: ReturnType<typeof decodeRtcProof>) {
    if (!this.current() || this.#remoteProof || this.#state !== 'pending') {
      this.close('duplicate-or-expired-proof')
      return
    }
    this.#remoteProof = true
    const ok = await verifyExpectedRtcProof(
      this.#binding,
      this.#options.role === 'connector' ? 'browser' : 'connector',
      encodeRtcProof(proof),
    )
    if (!this.current()) return
    if (!ok) {
      this.close('identity-or-binding')
      return
    }
    this.#remoteVerified = true
    this.finishVerification()
  }
  private finishVerification() {
    if (
      !this.current() ||
      this.#state !== 'pending' ||
      !this.#localProof ||
      !this.#remoteVerified
    )
      return
    this.#state = 'verified'
    this.#options.onVerified()
    if (this.current()) this.schedule()
  }
  receiveApplication(raw: unknown) {
    if (!this.current()) return
    try {
      const wire = boundRtcApplicationFrame(raw)
      if (this.#state !== 'verified' || wire !== READONLY_FIXTURE_STATUS)
        throw Error('readonly-only')
      if (this.#accepted === 1024) throw Error('message-budget')
      this.#accepted++
      if (this.#acceptedSamples.length === 16) this.#acceptedSamples.shift()
      this.#acceptedSamples.push('fixture-idle')
    } catch {
      this.close('application-frame')
    }
  }
  sendStatus() {
    if (!this.current() || this.#state !== 'verified' || !this.#localProof)
      return false
    try {
      this.#options.sendApplication(READONLY_FIXTURE_STATUS)
      return true
    } catch {
      this.close('send-failed')
      return false
    }
  }
  close(reason = 'closed') {
    if (this.#state === 'readonly') return
    this.#state = 'readonly'
    this.#reason = reason.slice(0, 64)
    clearTimeout(this.#timer)
    this.#options.onReadonly()
  }
  snapshot() {
    return {
      state: this.#state,
      reason: this.#reason,
      accepted: [...this.#acceptedSamples],
      acceptedTotal: this.#accepted,
      localProof: this.#localProof,
      remoteProof: this.#remoteProof,
      commands_enabled: false,
    }
  }
}
