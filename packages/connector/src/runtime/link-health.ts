// SPDX-License-Identifier: MIT
/** Per-printer Connector→printer link health for status snapshots and heartbeats. */

export const LINK_RTT_WINDOW_MS = 60_000
export const LINK_RECONNECT_WINDOW_MS = 3_600_000
export const LINK_HEALTH_MAX_PRINTERS = 100
/** Bound for a compact link-health / heartbeat wire frame (100 printers). */
export const LINK_HEALTH_FRAME_MAX_BYTES = 16_384
export const LINK_ERROR_CODE_MAX = 64

export type LinkState = 'connected' | 'reconnecting' | 'offline'

export type PrinterLinkHealth = Readonly<{
  printerKey: string
  link: LinkState
  /** Caller clock units of the last successful request, when any. */
  lastSuccessAt?: number
  /** Request round-trip p50 over the last 60 s, when samples exist. */
  rttP50Ms?: number
  /** Request round-trip p95 over the last 60 s, when samples exist. */
  rttP95Ms?: number
  reconnectsLastHour: number
  lastErrorCode?: string
}>

export type LinkHealthSnapshot = Readonly<{
  printers: readonly PrinterLinkHealth[]
}>

type Sample = { at: number; rttMs: number }
type Reconnect = { at: number }

type PrinterEntry = {
  link: LinkState
  lastSuccessAt?: number
  lastErrorCode?: string | undefined
  samples: Sample[]
  reconnects: Reconnect[]
}

function assertPrinterKey(printerKey: string) {
  if (
    typeof printerKey !== 'string' ||
    printerKey.length < 1 ||
    printerKey.length > 128
  )
    throw new Error('Invalid printer key')
}

function assertTime(at: number) {
  if (!Number.isFinite(at) || at < 0)
    throw new Error('Invalid link-health time')
}

function assertRtt(rttMs: number) {
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 600_000)
    throw new Error('Invalid round-trip sample')
}

function normalizeErrorCode(code: string): string {
  if (typeof code !== 'string' || code.length < 1)
    throw new Error('Invalid error code')
  return code.length <= LINK_ERROR_CODE_MAX
    ? code
    : code.slice(0, LINK_ERROR_CODE_MAX)
}

/** Nearest-rank percentile on a non-empty sorted ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('Empty percentile sample')
  if (sorted.length === 1) return sorted[0]!
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!
}

function pruneSamples(samples: Sample[], now: number) {
  const floor = now - LINK_RTT_WINDOW_MS
  let i = 0
  while (i < samples.length && samples[i]!.at < floor) i++
  if (i > 0) samples.splice(0, i)
}

function pruneReconnects(reconnects: Reconnect[], now: number) {
  const floor = now - LINK_RECONNECT_WINDOW_MS
  let i = 0
  while (i < reconnects.length && reconnects[i]!.at < floor) i++
  if (i > 0) reconnects.splice(0, i)
}

function projectPrinter(
  printerKey: string,
  entry: PrinterEntry,
  now: number,
): PrinterLinkHealth {
  pruneSamples(entry.samples, now)
  pruneReconnects(entry.reconnects, now)
  const rtts = entry.samples.map((s) => s.rttMs).sort((a, b) => a - b)
  return {
    printerKey,
    link: entry.link,
    reconnectsLastHour: entry.reconnects.length,
    ...(entry.lastSuccessAt !== undefined
      ? { lastSuccessAt: entry.lastSuccessAt }
      : {}),
    ...(rtts.length > 0
      ? { rttP50Ms: percentile(rtts, 50), rttP95Ms: percentile(rtts, 95) }
      : {}),
    ...(entry.lastErrorCode !== undefined
      ? { lastErrorCode: entry.lastErrorCode }
      : {}),
  }
}

/** Compact JSON projection used for frame-size checks and heartbeats. */
export function encodeLinkHealthSnapshot(snapshot: LinkHealthSnapshot): string {
  if (snapshot.printers.length > LINK_HEALTH_MAX_PRINTERS)
    throw new Error('Link health printer limit')
  const wire = JSON.stringify({
    t: 'link-health',
    printers: snapshot.printers.map((p) => {
      const row: Record<string, unknown> = {
        k: p.printerKey,
        s: p.link,
        r: p.reconnectsLastHour,
      }
      if (p.lastSuccessAt !== undefined) row.ls = p.lastSuccessAt
      if (p.rttP50Ms !== undefined) row.p50 = p.rttP50Ms
      if (p.rttP95Ms !== undefined) row.p95 = p.rttP95Ms
      if (p.lastErrorCode !== undefined) row.e = p.lastErrorCode
      return row
    }),
  })
  const bytes = Buffer.byteLength(wire, 'utf8')
  if (bytes > LINK_HEALTH_FRAME_MAX_BYTES)
    throw new Error('Link health frame limit')
  return wire
}

export function linkHealthWireBytes(snapshot: LinkHealthSnapshot): number {
  return Buffer.byteLength(encodeLinkHealthSnapshot(snapshot), 'utf8')
}

export type LinkHealthRegistry = Readonly<{
  ensure(printerKey: string): void
  setLinkState(printerKey: string, link: LinkState): void
  recordSuccess(printerKey: string, rttMs: number, at?: number): void
  recordFailure(printerKey: string, errorCode: string, at?: number): void
  recordReconnect(printerKey: string, at?: number): void
  snapshot(at?: number): LinkHealthSnapshot
  close(): void
}>

export function createLinkHealthRegistry(options?: {
  now?: () => number
  maxPrinters?: number
}): LinkHealthRegistry {
  const nowFn = options?.now ?? (() => Date.now())
  const maxPrinters = options?.maxPrinters ?? LINK_HEALTH_MAX_PRINTERS
  if (
    !Number.isSafeInteger(maxPrinters) ||
    maxPrinters < 1 ||
    maxPrinters > LINK_HEALTH_MAX_PRINTERS
  )
    throw new Error('Invalid link-health printer bound')
  const printers = new Map<string, PrinterEntry>()
  let closed = false

  function ready() {
    if (closed) throw new Error('Link health registry closed')
  }

  function entry(printerKey: string): PrinterEntry {
    assertPrinterKey(printerKey)
    let current = printers.get(printerKey)
    if (!current) {
      if (printers.size >= maxPrinters)
        throw new Error('Link health printer limit')
      current = {
        link: 'offline',
        samples: [],
        reconnects: [],
      }
      printers.set(printerKey, current)
    }
    return current
  }

  return {
    ensure(printerKey) {
      ready()
      entry(printerKey)
    },
    setLinkState(printerKey, link) {
      ready()
      switch (link) {
        case 'connected':
        case 'reconnecting':
        case 'offline':
          break
        default: {
          const _exhaustive: never = link
          void _exhaustive
          throw new Error('Invalid link state')
        }
      }
      const row = entry(printerKey)
      const previous = row.link
      row.link = link
      // Only a return from reconnecting counts; first connect from offline does not.
      if (link === 'connected' && previous === 'reconnecting') {
        const at = nowFn()
        assertTime(at)
        row.reconnects.push({ at })
        pruneReconnects(row.reconnects, at)
      }
    },
    recordSuccess(printerKey, rttMs, at) {
      ready()
      assertRtt(rttMs)
      const time = at ?? nowFn()
      assertTime(time)
      const row = entry(printerKey)
      row.lastSuccessAt = time
      row.lastErrorCode = undefined
      row.samples.push({ at: time, rttMs })
      pruneSamples(row.samples, time)
      if (row.link !== 'connected') {
        const previous = row.link
        row.link = 'connected'
        if (previous === 'reconnecting') {
          row.reconnects.push({ at: time })
          pruneReconnects(row.reconnects, time)
        }
      }
    },
    recordFailure(printerKey, errorCode, at) {
      ready()
      const time = at ?? nowFn()
      assertTime(time)
      const row = entry(printerKey)
      row.lastErrorCode = normalizeErrorCode(errorCode)
      if (row.link === 'connected') row.link = 'reconnecting'
      else if (row.link !== 'reconnecting') row.link = 'offline'
    },
    recordReconnect(printerKey, at) {
      ready()
      const time = at ?? nowFn()
      assertTime(time)
      const row = entry(printerKey)
      row.reconnects.push({ at: time })
      pruneReconnects(row.reconnects, time)
      row.link = 'reconnecting'
    },
    snapshot(at) {
      ready()
      const time = at ?? nowFn()
      assertTime(time)
      const keys = [...printers.keys()].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      )
      return {
        printers: keys.map((key) =>
          projectPrinter(key, printers.get(key)!, time),
        ),
      }
    },
    close() {
      closed = true
      printers.clear()
    },
  }
}

/**
 * Time one HTTP request to a printer origin and record success or failure.
 * Used by tests against the E16 mock harness (delay / drop fault hooks).
 */
export async function probePrinterLink(input: {
  registry: LinkHealthRegistry
  printerKey: string
  origin: string
  path?: string
  signal?: AbortSignal
  now?: () => number
  fetch?: typeof fetch
}): Promise<{ ok: boolean; rttMs: number; errorCode?: string }> {
  const path = input.path ?? '/server/info'
  const url = new URL(path, input.origin)
  if (url.hostname !== '127.0.0.1' && url.hostname !== '::1')
    throw new Error('Link probe requires loopback origin')
  const clock = input.now ?? (() => Date.now())
  const runFetch = input.fetch ?? fetch
  const started = clock()
  try {
    const response = await runFetch(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const rttMs = Math.max(0, clock() - started)
    if (!response.ok) {
      const errorCode = `http-${response.status}`
      input.registry.recordFailure(input.printerKey, errorCode, clock())
      // Drain to release the socket.
      try {
        await response.arrayBuffer()
      } catch {
        /* ignore */
      }
      return { ok: false, rttMs, errorCode }
    }
    try {
      await response.arrayBuffer()
    } catch {
      /* ignore body errors after a successful status */
    }
    input.registry.recordSuccess(input.printerKey, rttMs, clock())
    return { ok: true, rttMs }
  } catch (error) {
    const rttMs = Math.max(0, clock() - started)
    const errorCode =
      error instanceof Error && error.name === 'AbortError'
        ? 'aborted'
        : error instanceof Error &&
            typeof error.message === 'string' &&
            error.message
          ? normalizeProbeError(error)
          : 'drop'
    input.registry.recordFailure(input.printerKey, errorCode, clock())
    return { ok: false, rttMs, errorCode }
  }
}

function normalizeProbeError(error: Error): string {
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code) return normalizeErrorCode(code)
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(error.message))
    return 'drop'
  return normalizeErrorCode(error.message)
}
