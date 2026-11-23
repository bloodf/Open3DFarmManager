import type { Page, TestInfo } from '@playwright/test'

const FRAME_TAGS = new Set([
  'browser.begin',
  'browser.challenge',
  'browser.proof',
  'browser.wait',
  'rtc.ready',
  'rtc.offer',
  'rtc.answer',
  'rtc.binding',
  'rtc.ice',
  'rtc.close',
])

function frameTag(payload: string | Buffer): string {
  if (typeof payload !== 'string') return 'binary'
  try {
    const value: unknown = JSON.parse(payload)
    if (value && typeof value === 'object' && 't' in value) {
      const tag = value.t
      if (typeof tag === 'string' && FRAME_TAGS.has(tag)) return tag
    }
  } catch {
    // Count malformed frames without retaining their contents.
  }
  return 'other'
}

export function recordJourneyDiagnostics() {
  const counts: Record<string, number> = {}
  const count = (tag: string) => {
    counts[tag] = (counts[tag] ?? 0) + 1
  }
  return {
    watch(_name: string, page: Page) {
      page.on('console', (message) => {
        if (message.type() === 'error') count('console.error')
        if (message.type() === 'warning') count('console.warning')
      })
      page.on('pageerror', () => count('pageerror'))
      page.on('websocket', (socket) => {
        count('ws.open')
        socket.on('framesent', ({ payload }) =>
          count(`ws.sent.${frameTag(payload)}`),
        )
        socket.on('framereceived', ({ payload }) =>
          count(`ws.recv.${frameTag(payload)}`),
        )
        socket.on('socketerror', () => count('ws.error'))
        socket.on('close', () => count('ws.close'))
      })
    },
    async attach(testInfo: TestInfo): Promise<void> {
      await testInfo.attach('browser-signalling.json', {
        body: JSON.stringify(counts, null, 2),
        contentType: 'application/json',
      })
    },
  }
}
