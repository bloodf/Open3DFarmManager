import {
  createMoonrakerSubscription,
  type MoonrakerEvent,
} from '../../packages/connector/src/moonraker/subscription.ts'

const origin = process.argv[2]!
const overrides: unknown = JSON.parse(process.argv[3] ?? '{}')
const controller = new AbortController()
const mode = process.argv[4]
if (mode === 'pre-abort') controller.abort()
const events: MoonrakerEvent[] = []
const timer = setTimeout(
  () => controller.abort(),
  Number(process.argv[5] ?? 800),
)
try {
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey: 'fixture-printer', origin },
    allowedOrigins: [origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 150,
      reconnectMinMs: 30,
      reconnectMaxMs: 60,
      ...(typeof overrides === 'object' && overrides !== null ? overrides : {}),
    },
    onEvent(event) {
      events.push(event)
      if (event.kind === 'snapshot' && mode === 'throw')
        throw new Error('callback-fixture')
      if (event.kind === 'snapshot' && mode === 'async')
        return Promise.reject(new Error('async-fixture'))
      if (event.kind === 'snapshot' && mode === 'abort-snapshot')
        controller.abort()
    },
    signal: controller.signal,
  })
  let failure: string | null = null
  try {
    await subscription.done
  } catch (error) {
    failure = error instanceof Error ? error.message : 'unknown'
  }
  // Allow a native closing handshake, then report that abort emitted no later events.
  const countAtAbort = events.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  process.stdout.write(JSON.stringify({ events, countAtAbort, failure }))
} finally {
  clearTimeout(timer)
}
