import {
  MAX_RTC_PROOF_WIRE_BYTES,
  decodeRtcProof,
} from '../../../farm-protocol/src/rtc-session-binding.ts'
import { BoundedReceive } from './bounded-receive.ts'

export const MAX_RTC_APPLICATION_BYTES = 2048
const encoder = new TextEncoder()
/** Size validation only. This function grants no application-data authority. */
export function boundRtcApplicationFrame(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length > MAX_RTC_APPLICATION_BYTES ||
    encoder.encode(raw).byteLength > MAX_RTC_APPLICATION_BYTES
  )
    throw Error('Application frame limit')
  return raw
}

type InboxOptions = {
  paused: boolean
  inspect: (proof: ReturnType<typeof decodeRtcProof>) => Promise<void>
  onReadonly: () => void
}
/** Framing only, with no verified state. Inspection does not authenticate a peer.
 * Charge includes active UTF8 wire bytes until inspection settles. Stored strings
 * can occupy up to65536 UTF16 payload bytes, excluding JS/native overhead.
 */
export class RtcProofInbox {
  #queue: BoundedReceive
  #reason: string | undefined
  #options: Readonly<InboxOptions>
  constructor(options: InboxOptions) {
    this.#options = Object.freeze({ ...options })
    this.#queue = new BoundedReceive({
      limits: {
        frameBytes: MAX_RTC_PROOF_WIRE_BYTES,
        pendingFrames: 4,
        retainedBytes: 32768,
        totalFrames: 1024,
      },
      byteAccounting: 'utf8',
      paused: options.paused,
      reject: (reason) => this.close(reason),
      process: async (raw) => {
        try {
          const proof = decodeRtcProof(raw)
          await this.#options.inspect(proof)
        } catch {
          this.close('invalid-proof')
        }
      },
    })
  }
  receive(raw: unknown) {
    return this.#queue.receive(raw)
  }
  activate() {
    this.#queue.activate()
  }
  close(reason = 'closed') {
    if (this.#reason) return
    this.#reason = reason.slice(0, 64) || 'closed'
    this.#queue.close()
    this.#options.onReadonly()
  }
  snapshot() {
    return {
      state: this.#reason
        ? { kind: 'readonly', reason: this.#reason }
        : { kind: 'pending' },
      work: this.#queue.snapshot(),
    }
  }
}
