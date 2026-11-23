// SPDX-License-Identifier: MIT
// Fault parameters and shaping maths shared by the TCP and UDP forwarders of the
// loopback fault proxy. No sockets here, so every rule is unit-testable.

export type NetFaultConfig = {
  /** Fixed one-way delay added to every chunk or datagram, in ms. */
  latencyMs: number
  /** Uniform +/- jitter around latencyMs, in ms. */
  jitterMs: number
  /**
   * Loss probability 0..1. UDP datagrams are dropped. TCP hides loss behind
   * retransmission, so a "lost" TCP chunk is delivered `retransmitMs` late.
   */
  loss: number
  /** Retransmission penalty applied to a TCP chunk that the loss roll hit. */
  retransmitMs: number
  /** Bandwidth cap per direction in bytes per second, or null for unlimited. */
  bandwidthBytesPerSec: number | null
  /** Reset every TCP connection now and refuse (reset) new ones while true. */
  reset: boolean
  /**
   * Silently hold everything: TCP data is queued (as retransmission would) and
   * delivered when the blackhole lifts, UDP datagrams are dropped.
   */
  blackhole: boolean
  /** Drop every UDP datagram while TCP keeps flowing (a UDP-only firewall). */
  udpBlock: boolean
}

export const CLEAN_FAULTS: Readonly<NetFaultConfig> = Object.freeze({
  latencyMs: 0,
  jitterMs: 0,
  loss: 0,
  retransmitMs: 200,
  bandwidthBytesPerSec: null,
  reset: false,
  blackhole: false,
  udpBlock: false,
})

const MAX_DELAY_MS = 60_000

function finite(name: string, value: number, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${name} must be between ${min} and ${max}`)
}

/** Returns a new validated config; the inputs are never mutated. */
export function mergeFaults(
  current: Readonly<NetFaultConfig>,
  patch: Partial<NetFaultConfig>,
): NetFaultConfig {
  const next: NetFaultConfig = { ...current, ...patch }
  finite('latencyMs', next.latencyMs, 0, MAX_DELAY_MS)
  finite('jitterMs', next.jitterMs, 0, MAX_DELAY_MS)
  finite('loss', next.loss, 0, 1)
  finite('retransmitMs', next.retransmitMs, 0, MAX_DELAY_MS)
  if (next.bandwidthBytesPerSec !== null)
    finite('bandwidthBytesPerSec', next.bandwidthBytesPerSec, 1, 2 ** 40)
  for (const flag of ['reset', 'blackhole', 'udpBlock'] as const)
    if (typeof next[flag] !== 'boolean')
      throw new TypeError(`${flag} must be a boolean`)
  return next
}

/** Deterministic PRNG (mulberry32) so loss and jitter runs are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function jitteredDelay(
  config: Readonly<NetFaultConfig>,
  random: () => number,
): number {
  const jitter = config.jitterMs ? (random() * 2 - 1) * config.jitterMs : 0
  return Math.max(0, config.latencyMs + jitter)
}

/**
 * Per-direction serialiser for the bandwidth cap. `finish` returns when the last
 * byte of a `bytes`-long unit leaves the simulated link, starting no earlier
 * than `now` and queueing behind earlier units.
 */
export class LinkClock {
  private busyUntil = 0

  finish(now: number, bytes: number, config: Readonly<NetFaultConfig>): number {
    if (config.bandwidthBytesPerSec === null) return now
    const start = Math.max(now, this.busyUntil)
    this.busyUntil = start + (bytes * 1000) / config.bandwidthBytesPerSec
    return this.busyUntil
  }

  /** How long a unit arriving now would wait before it starts transmitting. */
  backlogMs(now: number): number {
    return Math.max(0, this.busyUntil - now)
  }
}
