const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000
const STABLE_CONNECTION_MS = 30_000

function randomFraction(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
}

/** Retry timing for signalling connection attempts only. Never replay printer commands. */
export class SignallingBackoff {
  private failures = 0
  private readonly random: () => number
  constructor(random: () => number = randomFraction) {
    this.random = random
  }

  nextDelay(): number {
    const sample = this.random()
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
      throw new Error('Random source must return a fraction in [0, 1)')
    const ceiling = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** this.failures)
    const floor = Math.max(MIN_DELAY_MS, Math.floor(ceiling / 2))
    // Integer inclusive interval; capped exponent avoids overflow during long outages.
    const delay = floor + Math.floor(sample * (ceiling - floor + 1))
    this.failures = Math.min(this.failures + 1, 6)
    return delay
  }

  /** Call with measured authenticated uptime, not merely a successful TCP handshake. */
  recordAuthenticatedUptime(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0)
      throw new Error('Invalid authenticated uptime')
    // Briefly flapping connections retain backoff pressure.
    if (durationMs >= STABLE_CONNECTION_MS) this.failures = 0
  }
}

/** Abortable wait owned by the future signalling loop; creates no network connection. */
export function waitForReconnect(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS)
    return Promise.reject(new Error('Invalid reconnect delay'))
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', aborted, { once: true })
  })
}
