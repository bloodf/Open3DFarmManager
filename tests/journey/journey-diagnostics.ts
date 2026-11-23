// Failure diagnostics for browser journeys: a bounded, secret-free record of
// what each browser page said on its signalling sockets and console, so a
// journey that never reaches authenticated status shows where the session
// stopped. Frame payloads are reduced to their `t` (frame type), `reason` and
// `status` fields; signatures, tokens and SDP are never retained.
import type { Page, TestInfo } from '@playwright/test'

const MAX_EVENTS = 400

type Event = Readonly<{ at: number; page: string; event: string }>

function frameSummary(payload: string | Buffer): string {
  if (typeof payload !== 'string') return `binary:${payload.length}`
  try {
    const value: unknown = JSON.parse(payload)
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const pick = (key: string) =>
        typeof record[key] === 'string' || typeof record[key] === 'number'
          ? `${key}=${String(record[key]).slice(0, 64)}`
          : undefined
      return (
        ['t', 'type', 'reason', 'status', 'code']
          .map(pick)
          .filter(Boolean)
          .join(' ') || `json:${payload.length}`
      )
    }
  } catch {
    /* Not JSON. */
  }
  return `text:${payload.length}`
}

export function recordJourneyDiagnostics() {
  const started = Date.now()
  let events: readonly Event[] = []
  const push = (page: string, event: string) => {
    events = [...events, { at: Date.now() - started, page, event }].slice(
      -MAX_EVENTS,
    )
  }
  return {
    watch(name: string, page: Page) {
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
          push(
            name,
            `console.${message.type()} ${message.text().slice(0, 240)}`,
          )
      })
      page.on('pageerror', (error) =>
        push(name, `pageerror ${String(error.message).slice(0, 240)}`),
      )
      page.on('websocket', (socket) => {
        const path = new URL(socket.url()).pathname
        push(name, `ws.open ${path}`)
        socket.on('framesent', ({ payload }) =>
          push(name, `ws.sent ${path} ${frameSummary(payload)}`),
        )
        socket.on('framereceived', ({ payload }) =>
          push(name, `ws.recv ${path} ${frameSummary(payload)}`),
        )
        socket.on('socketerror', (error) =>
          push(name, `ws.error ${path} ${error.slice(0, 160)}`),
        )
        socket.on('close', () => push(name, `ws.close ${path}`))
      })
    },
    async attach(
      testInfo: TestInfo,
      extra: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      const browser = events
        .map((e) => `${(e.at / 1000).toFixed(3)}s ${e.page} ${e.event}`)
        .join('\n')
      await testInfo.attach('browser-signalling.log', {
        body: browser,
        contentType: 'text/plain',
      })
      await testInfo.attach('runtime-diagnostics.json', {
        body: JSON.stringify(extra, null, 2),
        contentType: 'application/json',
      })
      console.error(
        'Journey diagnostics',
        JSON.stringify(extra),
        `\n${browser.split('\n').slice(-80).join('\n')}`,
      )
    },
  }
}
