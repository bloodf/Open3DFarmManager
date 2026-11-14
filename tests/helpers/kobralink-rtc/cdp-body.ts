import type { CDPSession, Page } from '@playwright/test'

/**
 * Network-level body capture for one page, independent of whether the page
 * script ever consumes a response. Chromium streams the bytes it receives to
 * this session (`Network.streamResourceContent`). A body counts as captured
 * only when it is complete: for an unencoded, unchunked response exactly the
 * declared Content-Length bytes arrived; otherwise Chromium reported
 * `Network.loadingFinished`. A body that finished before streaming began is
 * fetched whole at that moment, before a navigation can discard it. Chromium does not report a body the
 * page never drains as finished even when every declared byte arrived.
 * Partial, overflowing or unframed unfinished bodies are never read.
 */
export interface BodyFacts {
  declaredLength: number | null
  chunked: boolean
  encoded: boolean
  receivedBytes: number
  finished: boolean
  failed: boolean
  streamed: boolean
  fetched: boolean
  /** Bytes beyond the capture bound were dropped: never a complete body. */
  truncated: boolean
}
export interface CapturedBody {
  /** Complete body text; null unless loading finished with the full body. */
  readonly body: string | null
  /** Fixed numeric/boolean facts only; never header or body text. */
  readonly facts: BodyFacts
}

type Entry = {
  /** Request start (ms) derived as Playwright's `timing().startTime`. */
  startMs: number
  claimed: boolean
  chunks: Buffer[]
  bytes: number
  declaredLength: number | null
  chunked: boolean
  encoded: boolean
  finished: boolean
  failed: boolean
  streamed: boolean
  /** Whole body fetched from Chromium right when loading finished. */
  fetched: boolean
  truncated: boolean
  waiters: (() => void)[]
}

const MAX_CAPTURE_BYTES = 1_048_576
/**
 * Playwright and this session derive the same start stamp from the same
 * Chromium event within float noise (observed <= 0.012 ms); distinct
 * requests of one page are far apart. More than one match is refused.
 */
const START_TOLERANCE_MS = 0.05
const CAPTURED_TYPES = new Set(['Document', 'XHR', 'Fetch'])
/**
 * The single unclaimed capture whose start stamp is the given one. None or
 * several candidates both mean no attribution: another request's body is
 * never assigned to this response.
 */
export function uniqueMatch<T extends { startMs: number; claimed: boolean }>(
  candidates: readonly T[],
  startMs: number,
): T | null | 'ambiguous' {
  const matches = candidates.filter(
    (c) => !c.claimed && Math.abs(c.startMs - startMs) < START_TOLERANCE_MS,
  )
  if (matches.length > 1) return 'ambiguous'
  return matches[0] ?? null
}
const keyOf = (method: string, url: string, status: number) =>
  `${method.toUpperCase()} ${status} ${url}`

function header(headers: Record<string, unknown>, name: string) {
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name && typeof value === 'string') return value
  return null
}

function settle(entry: Entry) {
  for (const wake of entry.waiters.splice(0)) wake()
}

function complete(entry: Entry): boolean {
  if (entry.truncated || entry.failed) return false
  // A body fetched whole at loadingFinished is the complete decoded body.
  if (entry.fetched) return entry.finished
  if (!entry.streamed) return false
  // Exact wire framing proves completeness only for untransformed bodies:
  // decoded bytes are not comparable with a compressed or chunked length.
  if (entry.declaredLength !== null && !entry.encoded && !entry.chunked)
    return entry.bytes === entry.declaredLength
  return entry.finished
}

function view(entry: Entry | null): CapturedBody {
  const received = entry ? Buffer.concat(entry.chunks) : Buffer.alloc(0)
  const whole = !!entry && complete(entry) && received.length === entry.bytes
  return {
    body: whole ? received.toString('utf8') : null,
    facts: {
      declaredLength: entry?.declaredLength ?? null,
      chunked: entry?.chunked ?? false,
      encoded: entry?.encoded ?? false,
      receivedBytes: received.length,
      finished: entry?.finished ?? false,
      failed: entry?.failed ?? false,
      streamed: entry?.streamed ?? false,
      fetched: entry?.fetched ?? false,
      truncated: entry?.truncated ?? false,
    },
  }
}

function newEntry(headers: Record<string, unknown>, startMs: number): Entry {
  const declared = header(headers, 'content-length')
  return {
    startMs,
    claimed: false,
    chunks: [],
    bytes: 0,
    declaredLength:
      declared !== null && /^\d{1,9}$/.test(declared) ? Number(declared) : null,
    chunked: (header(headers, 'transfer-encoding') ?? '')
      .toLowerCase()
      .includes('chunked'),
    encoded: !['', 'identity'].includes(
      (header(headers, 'content-encoding') ?? '').trim().toLowerCase(),
    ),
    finished: false,
    failed: false,
    streamed: false,
    fetched: false,
    truncated: false,
    waiters: [],
  }
}

function attach(
  session: CDPSession,
  origin: string,
  queues: Map<string, Entry[]>,
) {
  const requests = new Map<
    string,
    { method: string; wallTime: number; timestamp: number }
  >()
  const byId = new Map<string, Entry>()
  const push = (entry: Entry, chunk: Buffer, front = false) => {
    if (entry.truncated || entry.bytes + chunk.length > MAX_CAPTURE_BYTES) {
      entry.truncated = true
      return
    }
    entry.bytes += chunk.length
    if (front) entry.chunks.unshift(chunk)
    else entry.chunks.push(chunk)
    if (complete(entry)) settle(entry)
  }
  session.on('Network.requestWillBeSent', (event) => {
    requests.set(event.requestId, {
      method: event.request.method,
      wallTime: event.wallTime,
      timestamp: event.timestamp,
    })
  })
  session.on('Network.responseReceived', (event) => {
    try {
      if (!CAPTURED_TYPES.has(event.type ?? '')) return
      if (new URL(event.response.url).origin !== origin) return
      const sent = requests.get(event.requestId)
      if (!sent) return
      const requestTime = event.response.timing?.requestTime
      if (requestTime === undefined) return
      // Same derivation as Playwright's `request.timing().startTime`.
      const startMs = (sent.wallTime + (requestTime - sent.timestamp)) * 1000
      const entry = newEntry(event.response.headers, startMs)
      byId.set(event.requestId, entry)
      const key = keyOf(sent.method, event.response.url, event.response.status)
      queues.set(key, [...(queues.get(key) ?? []), entry])
      void session
        .send('Network.streamResourceContent', { requestId: event.requestId })
        .then((result) => {
          if (entry.fetched) return
          entry.streamed = true
          push(entry, Buffer.from(result.bufferedData, 'base64'), true)
          if (complete(entry)) settle(entry)
        })
        .catch(() => {})
    } catch {
      /* Observation only. */
    }
  })
  session.on('Network.dataReceived', (event) => {
    const entry = byId.get(event.requestId)
    if (entry && event.data) push(entry, Buffer.from(event.data, 'base64'))
  })
  session.on('Network.loadingFinished', (event) => {
    const entry = byId.get(event.requestId)
    if (!entry) return
    entry.finished = true
    byId.delete(event.requestId)
    if (entry.streamed) {
      if (complete(entry)) settle(entry)
      return
    }
    // Finished before streaming began: fetch the whole body now, before a
    // navigation can discard it. A failed fetch leaves it uncaptured.
    void session
      .send('Network.getResponseBody', { requestId: event.requestId })
      .then((result) => {
        if (entry.streamed) return
        const whole = Buffer.from(
          result.body,
          result.base64Encoded ? 'base64' : 'utf8',
        )
        if (whole.length > MAX_CAPTURE_BYTES) entry.truncated = true
        else {
          entry.chunks = [whole]
          entry.bytes = whole.length
          entry.fetched = true
        }
        if (complete(entry)) settle(entry)
      })
      .catch(() => {})
  })
  session.on('Network.loadingFailed', (event) => {
    const entry = byId.get(event.requestId)
    if (!entry) return
    // A failed load never settles `finished`: the browser failure keeps its
    // own request-bound classification.
    entry.failed = true
    byId.delete(event.requestId)
  })
}

export async function captureBodies(page: Page, origin: string) {
  const queues = new Map<string, Entry[]>()
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    attach(session, origin, queues)
  } catch {
    /* Without a session every body stays uncaptured, never clean. */
  }
  return {
    /**
     * Pairs one Playwright response with its own network capture: same
     * method, URL and status and the same Chromium request start stamp.
     * Anything but exactly one unclaimed match stays uncaptured. The capture
     * may be announced slightly after Playwright's event. `finished` settles
     * only once the captured body is complete.
     */
    async take(method: string, url: string, status: number, startMs: number) {
      const key = keyOf(method, url, status)
      let entry: Entry | null = null
      for (let i = 0; i < 50 && !entry; i++) {
        const match = uniqueMatch(queues.get(key) ?? [], startMs)
        if (match === 'ambiguous') break
        if (match) {
          entry = match
          entry.claimed = true
        } else await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const found = entry
      const finished = new Promise<void>((resolve) => {
        if (found && complete(found)) resolve()
        else found?.waiters.push(resolve)
      })
      return { finished, read: () => view(found) }
    },
  }
}
