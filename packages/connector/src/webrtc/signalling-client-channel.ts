import {
  decodeSignallingServerFrame,
  encodeSignallingClientFrame,
  MAX_SIGNALLING_SOCKET_BYTES,
  type SignallingServerFrame,
  type SignallingClientFrame,
} from '../../../farm-protocol/src/signalling-socket.ts'
import { BoundedReceive } from './bounded-receive.ts'
export type SocketPort = {
  isOpen(): boolean
  bufferedBytes(): number
  send(wire: string, done: (error?: Error) => void): void
  bind(handlers: {
    open(): void
    message(raw: unknown): void
    error(): void
    close(): void
  }): () => void
  close(): void
  /** Optional evidence of an observed underlying socket close event. */
  waitClosed?(): Promise<void>
}
export type ChannelClock = { now(): number; wallNow(): number }
type ChannelOptions = {
  onFrame: (frame: SignallingServerFrame) => Promise<void>
  onOpen: () => void | Promise<void>
  onTerminal: (reason: string) => void
  clock?: ChannelClock
}
export const CLIENT_WRITE_LIMIT = 32768
/** Application-owned queues only. These caps do not bound native/socket RSS. */
export class SignallingClientChannel {
  #options: Readonly<{
    onFrame: (frame: SignallingServerFrame) => Promise<void>
    onOpen: () => void | Promise<void>
    onTerminal: (reason: string) => void
    clock?: ChannelClock
  }>
  #clock: ChannelClock
  #queue: BoundedReceive
  #port: SocketPort | undefined
  #unbind: (() => void) | undefined
  #terminal: string | undefined
  #connected = false
  #opened = false
  #authDeadline: number | undefined
  #lifetimeDeadline: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #pendingWrites = 0
  #writeBytes = 0
  #sent = 0
  #closed: Promise<void>
  #resolveClosed: () => void = () => {}
  #factorySettlement: Promise<void> = Promise.resolve()
  #ports = new Set<SocketPort>()
  #closeRequested = new WeakSet<SocketPort>()
  #closeFailed = false
  #disposal: Promise<void> | undefined
  constructor(options: ChannelOptions) {
    this.#options = Object.freeze({ ...options })
    this.#clock = options.clock ?? {
      now: () => performance.now(),
      wallNow: () => Date.now(),
    }
    const now = this.#clock.now()
    if (!Number.isFinite(now)) throw Error('Invalid client clock')
    this.#authDeadline = now + 8000
    this.#lifetimeDeadline = now + 30000
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    this.#queue = new BoundedReceive({
      limits: {
        frameBytes: MAX_SIGNALLING_SOCKET_BYTES,
        pendingFrames: 4,
        retainedBytes: 32768,
        totalFrames: 512,
      },
      byteAccounting: 'utf8',
      paused: false,
      reject: () => this.close('receive-capacity'),
      process: async (raw) => {
        if (!this.current()) return
        try {
          await this.#options.onFrame(decodeSignallingServerFrame(raw))
        } catch {
          this.close('invalid-server-frame')
        }
        this.current()
      },
    })
    this.schedule()
  }
  now() {
    return this.#clock.now()
  }
  wallNow() {
    return this.#clock.wallNow()
  }
  current() {
    if (this.#terminal) return false
    const now = this.#clock.now()
    if (
      !Number.isFinite(now) ||
      now >= this.#lifetimeDeadline ||
      (this.#authDeadline !== undefined && now >= this.#authDeadline)
    ) {
      this.close('deadline')
      return false
    }
    return true
  }
  deadlines() {
    return {
      authDeadline: this.#authDeadline,
      lifetimeDeadline: this.#lifetimeDeadline,
    }
  }
  private schedule() {
    clearTimeout(this.#timer)
    if (this.#terminal) return
    this.#timer = setTimeout(
      () => this.close('deadline'),
      Math.max(
        0,
        Math.min(this.#authDeadline ?? Infinity, this.#lifetimeDeadline) -
          this.#clock.now(),
      ),
    )
  }
  completeAdmission() {
    if (!this.current()) return
    this.#authDeadline = undefined
    this.schedule()
  }
  beginContext(expiresAt: number) {
    if (!this.current()) return
    const remaining = expiresAt - this.#clock.wallNow()
    if (!Number.isSafeInteger(expiresAt) || remaining <= 0) {
      this.close('context-expired')
      return
    }
    this.#authDeadline = Math.min(
      this.#authDeadline ?? Infinity,
      this.#clock.now() + 8000,
      this.#clock.now() + remaining,
      this.#lifetimeDeadline,
    )
    this.schedule()
  }
  capLease(lease: { issued_at: number; expires_at: number }) {
    if (!this.current()) return
    const wall = this.#clock.wallNow()
    if (
      !Number.isSafeInteger(lease.issued_at) ||
      !Number.isSafeInteger(lease.expires_at) ||
      wall < lease.issued_at ||
      wall >= lease.expires_at ||
      lease.expires_at - lease.issued_at > 30000
    ) {
      this.close('lease-expired')
      return
    }
    this.#lifetimeDeadline = Math.min(
      this.#lifetimeDeadline,
      this.#clock.now() + lease.expires_at - wall,
    )
    this.schedule()
  }
  connect(factory: () => SocketPort | Promise<SocketPort>) {
    if (this.#connected || !this.current()) return
    this.#connected = true
    const loading = Promise.resolve()
      .then(factory)
      .then((port) => {
        this.#ports.add(port)
        if (!this.current()) {
          this.requestPortClose(port)
          return undefined
        }
        return port
      })
    this.#factorySettlement = loading.then(
      () => {},
      () => {},
    )
    void (async () => {
      try {
        const port = await Promise.race([
          loading,
          this.#closed.then(() => undefined),
        ])
        if (!port) return
        if (!this.current()) {
          this.requestPortClose(port)
          return
        }
        this.#port = port
        this.#unbind = port.bind({
          open: () => {
            if (this.#opened || !this.current()) return
            this.#opened = true
            void Promise.resolve()
              .then(() => {
                if (this.current()) return this.#options.onOpen()
              })
              .catch(() => this.close('open-failed'))
          },
          message: (raw) => {
            if (!this.#terminal) void this.#queue.receive(raw)
          },
          error: () => this.close('socket-error'),
          close: () => this.close('socket-closed'),
        })
      } catch {
        this.close('socket-start')
      }
    })()
  }
  private requestPortClose(port: SocketPort) {
    if (this.#closeRequested.has(port)) return
    this.#closeRequested.add(port)
    try {
      port.close()
    } catch {
      this.#closeFailed = true
    }
  }
  /** Confirms factory settlement and observed socket closure, not native RTC teardown. */
  dispose(timeoutMs: number): Promise<void> {
    if (this.#disposal) return this.#disposal
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
      return Promise.reject(Error('Invalid disposal timeout'))
    const deadline = performance.now() + timeoutMs
    this.#disposal = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          (async () => {
            await this.#factorySettlement
            if (this.#closeFailed) throw Error('Socket close request failed')
            for (const port of this.#ports) {
              if (!port.waitClosed)
                throw Error('Socket close observation unavailable')
              await port.waitClosed()
            }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('Socket disposal timed out')),
              Math.max(0, deadline - performance.now()),
            )
          }),
        ])
        if (performance.now() >= deadline)
          throw Error('Socket disposal timed out')
      } finally {
        clearTimeout(timer)
      }
    })
    this.close('disposed')
    return this.#disposal
  }
  send(frame: SignallingClientFrame) {
    if (!this.current()) throw Error('Client terminal')
    try {
      const wire = encodeSignallingClientFrame(frame),
        charge = new TextEncoder().encode(wire).byteLength + 14
      const buffered = this.#port?.bufferedBytes()
      if (
        !this.#port?.isOpen() ||
        buffered === undefined ||
        !Number.isFinite(buffered) ||
        buffered < 0 ||
        buffered + charge > CLIENT_WRITE_LIMIT ||
        this.#writeBytes + charge > CLIENT_WRITE_LIMIT ||
        this.#pendingWrites === 4 ||
        this.#sent === 512
      )
        throw Error('Write capacity')
      this.#pendingWrites++
      this.#writeBytes += charge
      this.#sent++
      let pending = true
      this.#port.send(wire, (error) => {
        if (!pending) return
        pending = false
        if (this.#terminal) return
        this.#pendingWrites--
        this.#writeBytes -= charge
        if (error) this.close('socket-write')
      })
    } catch {
      this.close('send-failed')
      throw Error('Signalling send failed')
    }
  }
  close(reason = 'closed') {
    if (this.#terminal) return
    this.#terminal = reason.slice(0, 64) || 'closed'
    clearTimeout(this.#timer)
    this.#resolveClosed()
    this.#queue.close()
    this.#pendingWrites = 0
    this.#writeBytes = 0
    try {
      this.#unbind?.()
    } catch {}
    try {
      this.#options.onTerminal(this.#terminal)
    } catch {
      // Cleanup remains unconditional if an owner notification throws.
    } finally {
      try {
        if (this.#port) this.requestPortClose(this.#port)
      } catch {}
    }
  }
  snapshot() {
    return {
      state: this.#terminal ? 'readonly' : 'pending',
      reason: this.#terminal,
      sent: this.#sent,
      pendingWrites: this.#pendingWrites,
      writeBytes: this.#writeBytes,
      work: this.#queue.snapshot(),
      ...this.deadlines(),
    }
  }
}
