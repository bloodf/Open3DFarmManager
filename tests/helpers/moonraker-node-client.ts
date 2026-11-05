import {
  createMoonrakerSubscription,
  type MoonrakerEvent,
  type RawMoonrakerObservation,
  type RawMoonrakerUnavailable,
} from '../../packages/connector/src/moonraker/subscription.ts'

const origin = process.argv[2]!
const overrides: unknown = JSON.parse(process.argv[3] ?? '{}')
const controller = new AbortController()
const mode = process.argv[4]
if (mode === 'pre-abort') controller.abort()
const events: MoonrakerEvent[] = []
const raw: RawMoonrakerObservation[] = []
const rawUnavailable: RawMoonrakerUnavailable[] = []
// A completion spec replaces the fixed abort timer. The fixed timer starts
// before the subscription is established, so it also consumes the readiness
// probe, the websocket handshake and the node start up. A completion spec
// stops the child on the requested observation, snapshot or failure event and
// keeps the deadline as a bounded backstop.
// argv: origin, overrides, mode, durationMs, completionJson
const completion:
  | {
      deadlineMs: number
      rawObservations?: number
      snapshots?: number
      unavailable?: number
    }
  | undefined = process.argv[6] ? JSON.parse(process.argv[6]) : undefined
let completedBy:
  | 'observation'
  | 'snapshot'
  | 'unavailable'
  | 'deadline'
  | 'duration'
  | null = null
let snapshots = 0
let unavailable = 0
const timer = setTimeout(
  () => {
    completedBy = completion ? 'deadline' : 'duration'
    controller.abort()
  },
  completion ? completion.deadlineMs : Number(process.argv[5] ?? 800),
)
// The abort is deferred by one turn so the observation or event can finish
// publishing before the shutdown, and the deadline timer is cleared so the
// child exits as soon as the requested completion lands.
function complete(reason: 'observation' | 'snapshot' | 'unavailable'): void {
  if (completedBy !== null) return
  completedBy = reason
  clearTimeout(timer)
  setImmediate(() => controller.abort())
}
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
    ...(mode === 'raw'
      ? {
          onRawObservation(value: RawMoonrakerObservation) {
            raw.push(value)
            if (!completion?.rawObservations) return
            if (raw.length < completion.rawObservations) return
            complete('observation')
          },
          onRawUnavailable(value: RawMoonrakerUnavailable) {
            rawUnavailable.push(value)
          },
        }
      : {}),
    onEvent(event) {
      events.push(event)
      if (event.kind === 'snapshot') {
        snapshots++
        if (completion?.snapshots && snapshots >= completion.snapshots)
          complete('snapshot')
      }
      if (event.kind === 'unavailable') {
        unavailable++
        if (completion?.unavailable && unavailable >= completion.unavailable)
          complete('unavailable')
      }
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
  process.stdout.write(
    JSON.stringify({
      events,
      countAtAbort,
      failure,
      raw,
      rawUnavailable,
      completedBy,
    }),
  )
} finally {
  clearTimeout(timer)
}
