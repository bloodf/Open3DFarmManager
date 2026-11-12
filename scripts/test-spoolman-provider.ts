// Opt-in live check of the Connector Spoolman provider (REST + ws) against a
// seeded disposable service. The provider must only GET and never send ws data.
// The script itself PATCHes one synthetic spool (and restores it) to emit an event.
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createSpoolmanProvider } from '../packages/connector/src/runtime/spoolman-provider.ts'
import type { SpoolmanSnapshot } from '../packages/connector/src/runtime/spoolman-provider.ts'

const origin = process.env.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
if (!origin || process.env.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE !== 'yes')
  throw new Error('Explicit disposable synthetic Spoolman origin required')

const methods: string[] = []
const sent: unknown[] = []
const snapshots: SpoolmanSnapshot[] = []
const controller = new AbortController()
const provider = createSpoolmanProvider({
  config: {
    origin,
    farmId: '00000000-0000-4000-8000-000000000001',
    serviceId: '00000000-0000-4000-8000-000000000002',
    limit: 200,
  },
  signal: controller.signal,
  onSnapshot: (value) => snapshots.push(value),
  transport: {
    fetch: (input, init) => {
      methods.push(
        init?.method ?? (input instanceof Request ? input.method : 'GET'),
      )
      return fetch(input, init)
    },
    socket: (url) => {
      const socket = new WebSocket(url, { followRedirects: false })
      const send = socket.send.bind(socket)
      socket.send = (...args: Parameters<typeof send>) => {
        sent.push(args[0])
        return send(...args)
      }
      return socket
    },
  },
})
const until = async (predicate: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const spool = new URL('/api/v1/spool/2', origin)
const patch = (comment: string) =>
  fetch(spool, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment }),
    signal: AbortSignal.timeout(5000),
  }).then((response) => assert.equal(response.status, 200))

await until(() => provider.snapshot().kind === 'observed', 20_000, 'observed')
const first = provider.snapshot()
assert.equal(first.inventory?.items.length, 6)
const original = first.inventory?.items[1]?.comment ?? ''
const readsBefore = methods.length
await patch(`${original} w13`)
await until(() => methods.length > readsBefore, 20_000, 'event-driven refresh')
await until(
  () => provider.snapshot().inventory?.items[1]?.comment === `${original} w13`,
  20_000,
  'refreshed inventory',
)
await patch(original)
controller.abort()
await provider.done
const closed = provider.snapshot()
assert.equal(closed.kind, 'stale')
assert.equal(closed.inventory?.items.length, 6)
const readsAtClose = methods.length
await new Promise((resolve) => setTimeout(resolve, 3000))
assert.equal(methods.length, readsAtClose, 'no reads after close')
assert.ok(
  methods.every((method) => method === 'GET'),
  'provider issued non-GET',
)
assert.deepEqual(sent, [], 'provider sent ws data')
assert.equal(snapshots.at(-1)?.kind, 'stale')
console.log(
  JSON.stringify({
    result: 'passed',
    runtime: process.version,
    providerMethods: [...new Set(methods)],
    reads: readsAtClose,
    staleOnClose: true,
    wsSends: sent.length,
  }),
)
