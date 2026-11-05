export type CameraAccessUnit = {
  data: Uint8Array
  keyframe: boolean
  timestampUs: number
}

/** Test-only finite producer guard. The synchronous sink must consume or copy before returning. */
export class FiniteMediaBudget {
  #now: () => number
  #deadline: number
  #send: (unit: {
    data: Uint8Array
    keyframe: boolean
    timestampUs: number
    rtpTimestamp: number
  }) => boolean
  #lastNow: number
  #lastTimestamp = -1
  #lastAdmission: number | undefined
  #frames = 0
  #bytes = 0
  #terminal = false
  #sending = false

  constructor(options: {
    now: () => number
    deadline: number
    send: (unit: {
      data: Uint8Array
      keyframe: boolean
      timestampUs: number
      rtpTimestamp: number
    }) => boolean
  }) {
    const now = options.now()
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(options.deadline) ||
      options.deadline <= now ||
      options.deadline - now > 30000
    )
      throw Error('Invalid media lease')
    this.#now = options.now
    this.#lastNow = now
    this.#deadline = options.deadline
    this.#send = options.send
  }
  trySend(unit: CameraAccessUnit): boolean {
    const { data: input, timestampUs, keyframe } = unit
    if (this.#terminal) return false
    if (this.#sending) {
      this.close()
      return false
    }
    const now = this.#now()
    if (
      !Number.isFinite(now) ||
      now < this.#lastNow ||
      now >= this.#deadline ||
      typeof keyframe !== 'boolean' ||
      !(input instanceof Uint8Array) ||
      (typeof SharedArrayBuffer !== 'undefined' &&
        input.buffer instanceof SharedArrayBuffer) ||
      input.byteLength === 0 ||
      input.byteLength > 262144 ||
      !Number.isSafeInteger(timestampUs) ||
      timestampUs < 0 ||
      timestampUs <= this.#lastTimestamp ||
      (this.#lastAdmission !== undefined && now - this.#lastAdmission < 100) ||
      this.#frames >= 60 ||
      this.#bytes + input.byteLength > 4194304
    ) {
      this.close()
      return false
    }
    this.#lastNow = now
    this.#lastAdmission = now
    this.#lastTimestamp = timestampUs
    this.#frames++
    this.#bytes += input.byteLength
    const bytes = new Uint8Array(input)
    const rtpTimestamp = Number(
      ((BigInt(timestampUs) * 9n) / 100n) % 4294967296n,
    )
    this.#sending = true
    try {
      if (!this.#send({ data: bytes, keyframe, timestampUs, rtpTimestamp })) {
        this.close()
        return false
      }
    } catch {
      this.close()
      return false
    } finally {
      this.#sending = false
    }
    if (this.#terminal) return false
    if (this.#frames === 60 || this.#bytes === 4194304) this.close()
    return true
  }
  close() {
    this.#terminal = true
  }
  snapshot() {
    return {
      terminal: this.#terminal,
      frames: this.#frames,
      bytes: this.#bytes,
    }
  }
}
