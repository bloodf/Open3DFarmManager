const IDLE = Promise.resolve()
const encoder = new TextEncoder()

type ReceiveLimits = Readonly<{
  frameBytes: number
  pendingFrames: number
  retainedBytes: number
  totalFrames: number
}>
type ReceiveOptions = {
  limits: ReceiveLimits
  paused: boolean
  process: (raw: string) => Promise<void>
  reject: (reason: 'frame-limit' | 'message-budget' | 'pending-limit') => void
}

/** Bounds application-owned raw strings from synchronous callback admission onward. */
export class BoundedReceive {
  #options: Readonly<ReceiveOptions>
  #queue: string[] = []
  #activeBytes = 0
  #retainedBytes = 0
  #maxPending = 0
  #maxRetainedBytes = 0
  #admitted = 0
  #running = false
  #ready: boolean
  #closed = false
  #idle = IDLE
  #resolveIdle: (() => void) | undefined

  constructor(options: ReceiveOptions) {
    this.#options = Object.freeze({
      ...options,
      limits: Object.freeze({ ...options.limits }),
    })
    this.#ready = !options.paused
  }
  get ready() {
    return this.#ready && !this.#closed
  }
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#queue.length = 0
    this.#retainedBytes = this.#activeBytes
    if (!this.#running) this.finishBatch()
  }
  activate() {
    if (this.#closed || this.#ready) return
    this.#ready = true
    this.pump()
  }
  receive(raw: unknown): Promise<void> {
    if (this.#closed) return IDLE
    const limits = this.#options.limits
    // Check code units before allocating the bounded UTF-8 copy.
    if (
      typeof raw !== 'string' ||
      raw.length > limits.frameBytes ||
      encoder.encode(raw).byteLength > limits.frameBytes
    ) {
      this.reject('frame-limit')
      return IDLE
    }
    const size = raw.length * 2
    const pending = this.#queue.length + (this.#running ? 1 : 0)
    if (this.#admitted === limits.totalFrames) {
      this.reject('message-budget')
      return IDLE
    }
    if (
      pending === limits.pendingFrames ||
      this.#retainedBytes + size > limits.retainedBytes
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
  private reject(reason: Parameters<ReceiveOptions['reject']>[0]) {
    this.close()
    this.#options.reject(reason)
  }
  private pump() {
    if (!this.#running && this.#ready && this.#queue.length && !this.#closed)
      void this.drain()
  }
  private async drain() {
    this.#running = true
    try {
      while (!this.#closed && this.#queue.length) {
        const raw = this.#queue.shift()
        if (raw === undefined) break
        this.#activeBytes = raw.length * 2
        await this.#options.process(raw)
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
  snapshot() {
    return {
      admitted: this.#admitted,
      pending: this.#queue.length + (this.#running ? 1 : 0),
      retainedBytes: this.#retainedBytes,
      maxPending: this.#maxPending,
      maxRetainedBytes: this.#maxRetainedBytes,
    }
  }
}
