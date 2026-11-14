import type { Page } from '@playwright/test'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  classifyBody,
  findSecrets,
  normalizePath,
  type BodyOutcome,
  type Secret,
} from './qualification.ts'

const ALLOWED_WS_T = new Set([
  'config.begin',
  'config.ready',
  'config.binding',
  'config.context-closed',
  'rtc.offer',
  'rtc.answer',
  'rtc.ice',
  'rtc.close',
  'browser.begin',
  'browser.ready',
])
const MAX_RETAINED_BYTES = 24 * 1024 * 1024

function safeFrameType(raw: string | Buffer): string {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    const parsed: unknown = JSON.parse(text)
    const t =
      parsed && typeof parsed === 'object' && 't' in parsed
        ? parsed.t
        : undefined
    return typeof t === 'string' && ALLOWED_WS_T.has(t) ? t : 'other'
  } catch {
    return 'invalid'
  }
}

/** Allowlisted view of one data-channel or peer event. Never a payload. */
export type Diagnostic = Readonly<{
  atMs: number
  page: string
  peerId?: number
  event: string
  t?: string
  frameType?: string
  frameState?: string | null
  frameCode?: string | null
  frameReason?: string | null
  ok?: boolean
  reason?: string | null
  state?: string
}>

/**
 * Fault injection lives in the page and only ever loses or repeats a message
 * the page itself produced. It never fabricates authority, an acknowledgement
 * or a successful response.
 */
export type KobraFault = {
  /** Lose the Connector reply to the next request of this frame type. */
  dropResponseFor: string | null
  dropNextResponse: boolean
  /** Lose the next outgoing inventory message and keep its wire in memory. */
  dropInventory: boolean
  /** Send the kept inventory wire before the next status request. */
  replayBeforeStatus: boolean
  /** Send the kept inventory wire before the next inventory message. */
  replayBeforeInventory: boolean
  swallowInventoryResults: number
  inventoryWire: string | null
  injected: { ok: boolean; reason: string | null }[]
  lastChallengeBody: string | null
  lastCapabilityBody: string | null
  oldChallengeBody: string | null
  oldCapabilityBody: string | null
  channels: RTCDataChannel[]
}
declare global {
  interface Window {
    __kobraFault?: KobraFault
  }
}

function installPageProbe() {
  const fault: KobraFault = {
    dropResponseFor: null,
    dropNextResponse: false,
    dropInventory: false,
    replayBeforeStatus: false,
    replayBeforeInventory: false,
    swallowInventoryResults: 0,
    inventoryWire: null,
    injected: [],
    lastChallengeBody: null,
    lastCapabilityBody: null,
    oldChallengeBody: null,
    oldCapabilityBody: null,
    channels: [],
  }
  window.__kobraFault = fault
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.origin,
      )
      if (init?.method === 'POST' && typeof init.body === 'string') {
        if (url.pathname === '/api/configuration-authority/challenges')
          fault.lastChallengeBody = init.body
        if (url.pathname === '/api/configuration-authority/capabilities')
          fault.lastCapabilityBody = init.body
      }
    } catch {
      /* Observation only. */
    }
    return originalFetch(input, init)
  }
  const OriginalPeer = window.RTCPeerConnection
  const ALLOWED_DC_T = new Set([
    'proof',
    'request',
    'response',
    'inventory',
    'inventory-result',
  ])
  const ALLOWED_FRAME_TYPE = new Set([
    'prepare',
    'commit',
    'status',
    'cancel',
    'result',
    'unknown',
    'error',
  ])
  const ALLOWED_STATE = new Set([
    'prepared',
    'local-committed',
    'inventory-confirmed',
    'recovery-required',
  ])
  const ALLOWED_REASON = new Set([
    'no-durable-record',
    'connector-restarted',
    'timeout-after-write',
    'cancel-acknowledged',
    'unknown',
    'mismatch',
    'rejected',
    'busy',
    'not-available',
  ])
  let seq = 0
  const emit = (data: Record<string, unknown>) => {
    console.debug('__RTC_DIAG__:' + JSON.stringify(data))
  }
  const reasonOf = (value: unknown) =>
    typeof value === 'string' && ALLOWED_REASON.has(value) ? value : null
  const msgSummary = (raw: unknown): Record<string, unknown> => {
    try {
      if (typeof raw !== 'string') return { t: 'non-string' }
      const outer = JSON.parse(raw)
      const t =
        typeof outer?.t === 'string' && ALLOWED_DC_T.has(outer.t)
          ? outer.t
          : 'other'
      const summary: Record<string, unknown> = { t }
      if (typeof outer?.frame === 'string') {
        const inner = JSON.parse(outer.frame)
        summary.frameType =
          typeof inner?.type === 'string' && ALLOWED_FRAME_TYPE.has(inner.type)
            ? inner.type
            : 'other'
        summary.frameState =
          typeof inner?.state === 'string' && ALLOWED_STATE.has(inner.state)
            ? inner.state
            : null
        summary.frameCode =
          typeof inner?.code === 'string' &&
          /^[a-z0-9-]{1,40}$/.test(inner.code)
            ? inner.code
            : null
        summary.frameReason = reasonOf(inner?.reason)
      }
      if (t === 'inventory-result') {
        summary.ok = Boolean(outer?.ok)
        summary.reason = reasonOf(outer?.reason)
      }
      return summary
    } catch {
      return { t: 'invalid' }
    }
  }
  class DiagnosticPeer extends OriginalPeer {
    constructor(config?: RTCConfiguration) {
      super(config)
      const id = ++seq
      emit({ peerId: id, event: 'created' })
      this.addEventListener('signalingstatechange', () =>
        emit({ peerId: id, event: 'signaling', state: this.signalingState }),
      )
      this.addEventListener('icegatheringstatechange', () =>
        emit({
          peerId: id,
          event: 'gathering',
          state: this.iceGatheringState,
        }),
      )
      this.addEventListener('iceconnectionstatechange', () =>
        emit({ peerId: id, event: 'ice', state: this.iceConnectionState }),
      )
      this.addEventListener('connectionstatechange', () =>
        emit({
          peerId: id,
          event: 'connection',
          state: this.connectionState,
        }),
      )
      this.addEventListener('datachannel', (ev) => {
        const ch = ev.channel
        if (fault.channels.length < 32) fault.channels.push(ch)
        emit({
          peerId: id,
          event: 'dc-received',
          readyState: ch.readyState,
        })
        ch.addEventListener('open', () =>
          emit({ peerId: id, event: 'dc-open' }),
        )
        ch.addEventListener('close', () =>
          emit({ peerId: id, event: 'dc-close' }),
        )
        ch.addEventListener('error', () =>
          emit({ peerId: id, event: 'dc-error' }),
        )
        // Registered before the application handler, so a lost message is
        // lost for the application too.
        ch.addEventListener('message', (mev) => {
          const summary = msgSummary(mev.data)
          if (summary.t === 'response' && fault.dropNextResponse) {
            fault.dropNextResponse = false
            mev.stopImmediatePropagation()
            emit({ peerId: id, event: 'fault-lost-response', ...summary })
            return
          }
          if (
            summary.t === 'inventory-result' &&
            fault.swallowInventoryResults > 0
          ) {
            fault.swallowInventoryResults--
            mev.stopImmediatePropagation()
            fault.injected.push({
              ok: summary.ok === true,
              reason:
                typeof summary.reason === 'string' ? summary.reason : null,
            })
            emit({ peerId: id, event: 'fault-replay-result', ...summary })
            return
          }
          emit({ peerId: id, event: 'dc-in', ...summary })
        })
        const origSend = ch.send.bind(ch)
        const replay = (stage: string) => {
          if (!fault.inventoryWire) return
          fault.swallowInventoryResults++
          emit({ peerId: id, event: 'fault-replay-old-inventory', stage })
          origSend(fault.inventoryWire)
        }
        ch.send = ((data: string) => {
          const summary = msgSummary(data)
          if (
            summary.t === 'request' &&
            fault.dropResponseFor !== null &&
            summary.frameType === fault.dropResponseFor
          ) {
            fault.dropResponseFor = null
            fault.dropNextResponse = true
          }
          if (summary.t === 'inventory' && fault.dropInventory) {
            fault.dropInventory = false
            fault.inventoryWire = data
            fault.oldChallengeBody = fault.lastChallengeBody
            fault.oldCapabilityBody = fault.lastCapabilityBody
            emit({ peerId: id, event: 'fault-lost-inventory' })
            return
          }
          if (
            summary.t === 'request' &&
            summary.frameType === 'status' &&
            fault.replayBeforeStatus
          ) {
            fault.replayBeforeStatus = false
            replay('before-status')
          }
          if (summary.t === 'inventory' && fault.replayBeforeInventory) {
            fault.replayBeforeInventory = false
            replay('before-inventory')
          }
          emit({ peerId: id, event: 'dc-out', ...summary })
          return origSend(data)
        }) as typeof ch.send
      })
    }
    override async setRemoteDescription(
      desc: RTCSessionDescriptionInit,
    ): Promise<void> {
      const sdp = desc.sdp ?? ''
      emit({
        event: 'setRemoteDescription',
        type: desc.type,
        candidates: (sdp.match(/^a=candidate:/gm) ?? []).length,
        hasMdns: /\.local\b/i.test(sdp),
      })
      return super.setRemoteDescription(desc)
    }
    override async setLocalDescription(
      desc?: RTCLocalSessionDescriptionInit,
    ): Promise<void> {
      await super.setLocalDescription(desc)
      const sdp = this.localDescription?.sdp ?? ''
      emit({
        event: 'setLocalDescription',
        type: this.localDescription?.type ?? null,
        candidates: (sdp.match(/^a=candidate:/gm) ?? []).length,
        hasMdns: /\.local\b/i.test(sdp),
      })
    }
  }
  window.RTCPeerConnection = DiagnosticPeer
}

export type HttpIssue = Readonly<{
  page: string
  method: string
  path: string
  status: number
}>
export type FailedRequest = Readonly<{
  page: string
  method: string
  path: string
  error: string
}>
export type ConsoleIssue = Readonly<{
  page: string
  type: string
  text: string
}>

/**
 * Observes one page without intercepting HTTP: boundary timing, data-channel
 * frame kinds, console, network errors, and in-memory copies of what the
 * browser received so they can be searched for credentials. Nothing retained
 * for the search is ever written to disk.
 */
export async function instrumentPage(input: {
  page: Page
  label: string
  evidence: string
  origin: string
  t0: number
}) {
  const { page, label } = input
  const diagnostics: Diagnostic[] = []
  const httpIssues: HttpIssue[] = []
  const failedRequests: FailedRequest[] = []
  const consoleIssues: ConsoleIssue[] = []
  const http: { method: string; path: string; status: number; atMs: number }[] =
    []
  const retained = {
    responses: [] as string[],
    console: [] as string[],
    websocket: [] as string[],
    bytes: 0,
    truncated: false,
  }
  type BodyEntry = { method: string; path: string; status: number }
  const pending = new Map<Promise<unknown>, BodyEntry>()
  /** Lets a later `requestfailed` settle the body task of the same request. */
  const failing = new WeakMap<object, (error: string) => void>()
  const failed = new WeakMap<object, string>()
  const bodies: Record<BodyOutcome, number> = {
    read: 0,
    bodyless: 0,
    aborted: 0,
    unread: 0,
  }
  const frames: { atMs: number; dir: 'out' | 'in'; path: string; t: string }[] =
    []
  const now = () => Math.round(performance.now() - input.t0)
  const record = (entry: Readonly<Record<string, unknown>>) =>
    appendFile(
      join(input.evidence, 'boundary.jsonl'),
      JSON.stringify({ atMs: now(), page: label, ...entry }) + '\n',
      { mode: 0o600 },
    ).catch(() => {})
  const keep = (bucket: string[], text: string) => {
    if (retained.bytes + text.length > MAX_RETAINED_BYTES) {
      retained.truncated = true
      return
    }
    retained.bytes += text.length
    bucket.push(text)
  }
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.startsWith('__RTC_DIAG__:')) {
      try {
        const payload: unknown = JSON.parse(text.slice('__RTC_DIAG__:'.length))
        if (payload && typeof payload === 'object') {
          const entry = { atMs: now(), page: label, ...payload } as Diagnostic
          if (diagnostics.length < 4096) diagnostics.push(entry)
          void record({ side: 'browser-rtc', ...payload })
        }
      } catch {
        /* Malformed diagnostic lines are ignored. */
      }
      return
    }
    keep(retained.console, text)
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const issue = {
        page: label,
        type: msg.type(),
        text: normalizePath(text.replaceAll(input.origin, '')),
      }
      if (consoleIssues.length < 256) consoleIssues.push(issue)
      void record({ side: 'browser-console', type: issue.type })
    }
  })
  page.on('pageerror', (error) => {
    keep(retained.console, String(error))
    if (consoleIssues.length < 256)
      consoleIssues.push({
        page: label,
        type: 'pageerror',
        text: normalizePath(
          `${error.name}: ${error.message}`.replaceAll(input.origin, ''),
        ),
      })
    void record({ side: 'browser-pageerror' })
  })
  page.on('response', (res) => {
    try {
      const url = new URL(res.url())
      if (url.origin !== input.origin) return
      const request = res.request()
      const type = request.resourceType()
      if (url.pathname.startsWith('/api/')) {
        const entry = {
          method: request.method(),
          path: normalizePath(url.pathname),
          status: res.status(),
        }
        http.push({ ...entry, atMs: now() })
        void record({ side: 'browser-http', ...entry })
        if (res.status() >= 400 && httpIssues.length < 256)
          httpIssues.push({ page: label, ...entry })
      }
      if (type === 'document' || type === 'xhr' || type === 'fetch') {
        const entry: BodyEntry = {
          method: request.method(),
          path: normalizePath(url.pathname),
          status: res.status(),
        }
        // Headers are complete as soon as the response exists.
        keep(retained.responses, JSON.stringify(res.headers()))
        // A response whose request the browser later fails never reports
        // `finished`, so the failure event settles the same task.
        const failure = new Promise<string>((resolve) => {
          const known = failed.get(request)
          if (known) resolve(known)
          else failing.set(request, resolve)
        })
        const task = Promise.race([
          res
            .finished()
            .then((error) =>
              error
                ? (request.failure()?.errorText ?? 'unknown').slice(0, 60)
                : null,
            ),
          failure,
        ])
          .then(async (error) => {
            // Even after a failure the browser may still hold what arrived.
            const body = await Promise.race([
              res.text().catch(() => null),
              new Promise<null>((resolve) => setTimeout(resolve, 2000, null)),
            ])
            if (body !== null) keep(retained.responses, body)
            return classifyBody({
              ...entry,
              bodyRead: body !== null,
              failure: error,
            })
          })
          .catch((): BodyOutcome => 'unread')
          .then((outcome) => {
            bodies[outcome]++
            if (outcome === 'aborted' || outcome === 'unread')
              void record({ side: `browser-body-${outcome}`, ...entry })
          })
        pending.set(task, entry)
        void task.then(() => pending.delete(task))
      }
    } catch {
      /* Observation only. */
    }
  })
  page.on('requestfailed', (req) => {
    try {
      const url = new URL(req.url())
      const error = (req.failure()?.errorText ?? 'unknown').slice(0, 60)
      failed.set(req, error)
      failing.get(req)?.(error)
      if (!url.pathname.startsWith('/api/')) return
      const entry = {
        page: label,
        method: req.method(),
        path: normalizePath(url.pathname),
        error,
      }
      if (failedRequests.length < 256) failedRequests.push(entry)
      void record({
        side: 'browser-http-failed',
        method: entry.method,
        path: entry.path,
        error: entry.error,
      })
    } catch {
      /* Observation only. */
    }
  })
  page.on('websocket', (ws) => {
    let path = 'unknown'
    try {
      path = new URL(ws.url()).pathname
    } catch {
      /* Keep the placeholder. */
    }
    void record({ side: 'browser-ws', state: 'open', path })
    const frame = (side: string, payload: string | Buffer) => {
      keep(
        retained.websocket,
        typeof payload === 'string' ? payload : payload.toString('utf8'),
      )
      if (frames.length < 4096)
        frames.push({
          atMs: now(),
          dir: side === 'browser-ws-out' ? 'out' : 'in',
          path,
          t: safeFrameType(payload),
        })
      void record({
        side,
        path,
        t: safeFrameType(payload),
        bytes:
          typeof payload === 'string' ? payload.length : payload.byteLength,
      })
    }
    ws.on('framesent', ({ payload }) => frame('browser-ws-out', payload))
    ws.on('framereceived', ({ payload }) => frame('browser-ws-in', payload))
    ws.on('socketerror', () => {
      void record({ side: 'browser-ws', state: 'error', path })
    })
    ws.on('close', () => {
      void record({ side: 'browser-ws', state: 'close', path })
    })
  })
  await page.addInitScript(installPageProbe)
  return {
    label,
    page,
    record,
    diagnostics,
    http,
    frames,
    httpIssues,
    failedRequests,
    consoleIssues,
    /** Index marker so a scenario can look only at what happened after it. */
    mark: () => ({
      diagnostics: diagnostics.length,
      http: http.length,
      frames: frames.length,
    }),
    /** Secret labels found in what this page received, logged or still shows. */
    async scan(secrets: readonly Secret[]) {
      // Bounded: a response body that never arrives is reported as
      // unobserved, never silently treated as clean.
      await Promise.race([
        Promise.allSettled([...pending.keys()]),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ])
      for (const entry of pending.values())
        await record({
          side: 'browser-body-unread',
          ...entry,
          error: 'body-read-deadline',
        })
      const unread = pending.size + bodies.unread
      let inspected = !page.isClosed()
      const state = page.isClosed()
        ? { storage: '', dom: '' }
        : await page
            .evaluate(async () => {
              const dump = (area: Storage) =>
                Object.entries({ ...area })
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join('\n')
              const databases =
                'databases' in indexedDB ? await indexedDB.databases() : []
              return {
                storage: [
                  dump(localStorage),
                  dump(sessionStorage),
                  document.cookie,
                  databases.map((db) => db.name ?? '').join('\n'),
                ].join('\n'),
                dom: document.documentElement.outerHTML,
              }
            })
            .catch(() => {
              inspected = false
              return { storage: '', dom: '' }
            })
      const cookies = page.isClosed()
        ? ''
        : await page
            .context()
            .cookies()
            .then((list) => JSON.stringify(list))
            .catch(() => {
              inspected = false
              return ''
            })
      return {
        responses: findSecrets(retained.responses.join('\n'), secrets),
        console: findSecrets(retained.console.join('\n'), secrets),
        websocket: findSecrets(retained.websocket.join('\n'), secrets),
        storage: findSecrets(state.storage + '\n' + cookies, secrets),
        dom: findSecrets(state.dom, secrets),
        retainedResponses: retained.responses.length,
        retainedFrames: retained.websocket.length,
        truncated: retained.truncated,
        /** Storage and DOM were actually read from the live page. */
        inspected,
        /** Response bodies still unread when the bounded wait ended. */
        unread,
        /** Responses the browser itself aborted before completion. */
        aborted: bodies.aborted,
        /** Responses that carry no body by protocol. */
        bodyless: bodies.bodyless,
        /** Response bodies actually read and searched. */
        read: bodies.read,
      }
    },
  }
}
export type PageObserver = Awaited<ReturnType<typeof instrumentPage>>
