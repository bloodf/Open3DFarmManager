import type { CDPSession, Page } from '@playwright/test'

/**
 * Network-level body capture for one page, independent of whether the page
 * script ever consumes a response. Chromium streams the bytes it receives to
 * this session (`Network.streamResourceContent`). A body counts as captured
 * only after `Network.loadingFinished` for the same request and, when a
 * length was declared, only with exactly that many bytes: a partial or
 * never-finished body is never treated as read.
 */
export interface BodyFacts {
  declaredLength: number | null
  chunked: boolean
  receivedBytes: number
  finished: boolean
  failed: boolean
  streamed: boolean
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
  finished: boolean
  failed: boolean
  streamed: boolean
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

function view(entry: Entry | null): CapturedBody {
  const received = entry ? Buffer.concat(entry.chunks) : Buffer.alloc(0)
  const complete =
    !!entry &&
    entry.finished &&
    entry.streamed &&
    received.length < MAX_CAPTURE_BYTES &&
    (entry.declaredLength === null || received.length === entry.declaredLength)
  return {
    body: complete ? received.toString('utf8') : null,
    facts: {
      declaredLength: entry?.declaredLength ?? null,
      chunked: entry?.chunked ?? false,
      receivedBytes: received.length,
      finished: entry?.finished ?? false,
      failed: entry?.failed ?? false,
      streamed: entry?.streamed ?? false,
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
    finished: false,
    failed: false,
    streamed: false,
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
    if (entry.bytes + chunk.length > MAX_CAPTURE_BYTES) {
      entry.bytes = MAX_CAPTURE_BYTES
      return
    }
    entry.bytes += chunk.length
    if (front) entry.chunks.unshift(chunk)
    else entry.chunks.push(chunk)
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
          entry.streamed = true
          push(entry, Buffer.from(result.bufferedData, 'base64'), true)
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
    settle(entry)
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
     * only once loading finished at network level.
     */
    async take(method: string, url: string, status: number, startMs: number) {
      const key = keyOf(method, url, status)
      let entry: Entry | null = null
      for (let i = 0; i < 50 && !entry; i++) {
        const matches = (queues.get(key) ?? []).filter(
          (e) =>
            !e.claimed && Math.abs(e.startMs - startMs) < START_TOLERANCE_MS,
        )
        if (matches.length === 1) {
          entry = matches[0]!
          entry.claimed = true
        } else if (matches.length > 1) break
        else await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const found = entry
      const finished = new Promise<void>((resolve) => {
        if (found?.finished) resolve()
        else found?.waiters.push(resolve)
      })
      return { finished, read: () => view(found) }
    },
  }
}
