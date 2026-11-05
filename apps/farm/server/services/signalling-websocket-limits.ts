import {
  SIGNALLING_ADMISSION_TIMEOUT_MS,
  SIGNALLING_NATIVE_MAX_PAYLOAD,
  SIGNALLING_PENDING_BYTE_LIMIT,
  SIGNALLING_PREAUTH_LIMIT,
} from './signalling-websocket-boundary.ts'

export interface SignallingResourceClock {
  now(): number
  after(milliseconds: number, callback: () => void): () => void
}
export interface SignallingSocketPort {
  bufferedAmount(): number
  send(text: string): void
  terminate(): void
}
interface Slot {
  readonly port: SignallingSocketPort
  readonly start: number
  last: number
  pending: boolean
  closed: boolean
  bytes: number
  frames: string[]
  running: boolean
  cancelAdmission: () => void
  cancelLifetime: () => void
}
/** An opaque resource handle confers no authentication or command authority. */
const resourceBrand = Symbol('signalling-resource')
export interface SignallingResourceHandle {
  readonly [resourceBrand]: true
}

/** All queued and in-flight frames count until their processor settles. Closed
 * processors retain their global slot, preventing disconnects from bypassing the
 * bound when an external async operation cannot be cancelled. */
export class SignallingWebSocketResources {
  readonly #clock: SignallingResourceClock
  readonly #slots = new Map<SignallingResourceHandle, Slot>()
  #pending = 0
  #processing = 0
  #disposed = false

  constructor(clock: SignallingResourceClock) {
    this.#clock = clock
  }

  reserve(port: SignallingSocketPort): SignallingResourceHandle | null {
    const now = this.#clock.now()
    if (
      this.#disposed ||
      !Number.isFinite(now) ||
      now < 0 ||
      this.#pending >= SIGNALLING_PREAUTH_LIMIT ||
      this.#slots.size >= 64
    ) {
      port.terminate()
      return null
    }
    const handle: SignallingResourceHandle =
      Object.freeze<SignallingResourceHandle>({
        [resourceBrand]: true,
      })
    const slot: Slot = {
      port,
      start: now,
      last: now,
      pending: true,
      closed: false,
      bytes: 0,
      frames: [],
      running: false,
      cancelAdmission: () => {},
      cancelLifetime: () => {},
    }
    this.#slots.set(handle, slot)
    this.#pending++
    slot.cancelAdmission = this.#clock.after(
      SIGNALLING_ADMISSION_TIMEOUT_MS,
      () => this.close(handle),
    )
    slot.cancelLifetime = this.#clock.after(30_000, () => this.close(handle))
    return handle
  }

  /** Ends only the resource admission timeout. The original hard deadline stays. */
  finishPreauth(handle: SignallingResourceHandle): boolean {
    const slot = this.#live(handle)
    if (!slot) return false
    if (slot.pending) {
      slot.pending = false
      this.#pending--
      slot.cancelAdmission()
    }
    return true
  }

  receive(
    handle: SignallingResourceHandle,
    text: string,
    process: (text: string) => Promise<void>,
  ): boolean {
    const slot = this.#live(handle)
    if (!slot) return false
    const bytes = Buffer.byteLength(text)
    const buffered = slot.port.bufferedAmount()
    if (
      bytes > SIGNALLING_NATIVE_MAX_PAYLOAD ||
      slot.frames.length + Number(slot.running) >= 8 ||
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      slot.bytes + bytes + buffered > SIGNALLING_PENDING_BYTE_LIMIT ||
      (!slot.running && this.#processing >= 32)
    ) {
      this.close(handle)
      return false
    }
    slot.bytes += bytes
    slot.frames.push(text)
    if (!slot.running) void this.#drain(handle, slot, process)
    return true
  }

  /** Includes upgrade cookie unsealing and later external auth work. A closed
   * socket cannot release this capacity while its underlying operation runs. */
  async work<T>(
    handle: SignallingResourceHandle,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!this.#live(handle)) return { ok: false }
    if (this.#processing >= 32) {
      this.close(handle)
      return { ok: false }
    }
    this.#processing++
    try {
      const value = await operation()
      return this.#live(handle) ? { ok: true, value } : { ok: false }
    } catch {
      this.close(handle)
      return { ok: false }
    } finally {
      this.#processing--
    }
  }

  send(handle: SignallingResourceHandle, text: string): boolean {
    const slot = this.#live(handle)
    if (!slot) return false
    const bytes = Buffer.byteLength(text)
    const buffered = slot.port.bufferedAmount()
    if (
      bytes > SIGNALLING_NATIVE_MAX_PAYLOAD ||
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      slot.bytes + buffered + bytes > SIGNALLING_PENDING_BYTE_LIMIT
    ) {
      this.close(handle)
      return false
    }
    try {
      slot.port.send(text)
      return true
    } catch {
      this.close(handle)
      return false
    }
  }

  close(handle: SignallingResourceHandle): void {
    const slot = this.#slots.get(handle)
    if (!slot) return
    slot.closed = true
    this.#slots.delete(handle)
    if (slot.pending) this.#pending--
    slot.cancelAdmission()
    slot.cancelLifetime()
    for (const text of slot.frames) slot.bytes -= Buffer.byteLength(text)
    slot.frames = []
    slot.port.terminate()
  }

  dispose(): void {
    this.#disposed = true
    for (const handle of this.#slots.keys()) this.close(handle)
  }

  #live(handle: SignallingResourceHandle): Slot | null {
    const slot = this.#slots.get(handle)
    if (!slot) return null
    const now = this.#clock.now()
    if (
      !Number.isFinite(now) ||
      now < slot.last ||
      now - slot.start >= (slot.pending ? 8000 : 30_000)
    ) {
      this.close(handle)
      return null
    }
    slot.last = now
    return slot
  }

  async #drain(
    handle: SignallingResourceHandle,
    slot: Slot,
    process: (text: string) => Promise<void>,
  ): Promise<void> {
    slot.running = true
    this.#processing++
    try {
      while (this.#live(handle)) {
        const text = slot.frames.shift()
        if (text === undefined) break
        try {
          await process(text)
        } finally {
          slot.bytes -= Buffer.byteLength(text)
        }
        // Recheck the monotonic deadline after every async processor.
        if (!this.#live(handle)) break
      }
    } catch {
      this.close(handle)
    } finally {
      slot.running = false
      this.#processing--
    }
  }
}
