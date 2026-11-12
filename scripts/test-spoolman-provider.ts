// Opt-in live check of the Connector Spoolman provider (REST + ws) against a
// seeded DISPOSABLE service. The provider must only issue GET requests (the
// websocket is out of scope for this check). This script itself PATCHes one
// synthetic spool and restores it in a finally block: never point it at real inventory.
import assert from 'node:assert/strict'
import seed from '../infra/sim/spoolman/seed.json' with { type: 'json' }
import { createSpoolmanProvider } from '../packages/connector/src/runtime/spoolman-provider.ts'
import { createLoopbackSpoolmanReader } from '../packages/connector/src/spoolman/http-read.ts'
import type { SpoolmanSnapshot } from '../packages/connector/src/runtime/spoolman-provider.ts'
import { qualificationScope } from './spoolman-qualification-context.ts'

const requested = process.env.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
if (!requested || process.env.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE !== 'yes')
  throw new Error('Explicit disposable synthetic Spoolman origin required')
// Throws unless the origin is canonical loopback http; nothing is requested here.
createLoopbackSpoolmanReader({
  origin: requested,
  context: { ...qualificationScope, limit: 200 },
  timeoutMs: 10000,
})
const origin = new URL(requested).origin

const InvalidateBudgetMs = 3000 // event must mark the snapshot stale promptly
const RefreshBudgetMs = 20_000 // reads are rate limited to one per ~15 s
const call = (path: string, init: RequestInit = {}) =>
  fetch(new URL(`/api/v1/${path}`, origin), {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(5000),
    ...init,
  })
const raw = async () => {
  const response = await call('spool?allow_archived=true')
  assert.equal(response.status, 200)
  return (await response.json()) as {
    id: number
    comment?: string
    remaining_weight: number
  }[]
}
// Refuse to write unless the inventory is exactly the seed fixture.
const before = await raw()
assert.deepEqual(
  before.map((spool) => spool.comment),
  seed.spools.map((spool) => spool.comment),
  'inventory is not exactly the seed fixture',
)
assert.deepEqual(
  before.map((spool) => spool.remaining_weight),
  [1000, 900, 800, 700, 600, 500],
  'inventory weights are not the seed fixture',
)
const target = before[1]!
const originalWeight = target.remaining_weight
const patch = async (weight: number) => {
  const response = await call(`spool/${target.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ remaining_weight: weight }),
  })
  assert.equal(response.status, 200)
  await response.body?.cancel()
}

const methods: string[] = []
const snapshots: SpoolmanSnapshot[] = []
const controller = new AbortController()
const provider = createSpoolmanProvider({
  config: { origin, ...qualificationScope, limit: 200 },
  signal: controller.signal,
  onSnapshot: (value) => snapshots.push(value),
  transport: {
    fetch: (input, init) => {
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method !== 'GET') throw new Error(`Provider issued ${method}`)
      methods.push(method)
      return fetch(input, init)
    },
  },
})
const until = async (predicate: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const weightOf = () =>
  provider.snapshot().inventory?.items.find((item) => item.id === target.id)
    ?.remaining_weight

let invalidateMs = 0
let refreshMs = 0
let patched = false
try {
  await until(() => provider.snapshot().kind === 'observed', 20_000, 'observed')
  assert.equal(provider.snapshot().inventory?.items.length, 6)
  // Let the initial read burst settle so the next read is event-driven.
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const snapshotsBefore = snapshots.length
  const changedAt = Date.now()
  patched = true
  await patch(originalWeight - 1)
  await until(
    () => snapshots.slice(snapshotsBefore).some((v) => v.kind === 'stale'),
    InvalidateBudgetMs,
    'event-driven stale snapshot',
  )
  invalidateMs = Date.now() - changedAt
  await until(
    () => weightOf() === originalWeight - 1,
    RefreshBudgetMs,
    'refreshed inventory',
  )
  refreshMs = Date.now() - changedAt
} finally {
  if (patched) await patch(originalWeight)
  controller.abort()
  await provider.done
}
assert.equal((await raw())[1]?.remaining_weight, originalWeight)
const closed = provider.snapshot()
assert.equal(closed.kind, 'stale')
assert.equal(closed.inventory?.items.length, 6)
const readsAtClose = methods.length
await new Promise((resolve) => setTimeout(resolve, 3000))
assert.equal(methods.length, readsAtClose, 'no reads after close')
assert.equal(snapshots.at(-1)?.kind, 'stale')
console.log(
  JSON.stringify({
    result: 'passed',
    runtime: process.version,
    providerMethods: [...new Set(methods)],
    reads: readsAtClose,
    invalidateMs,
    refreshMs,
    staleOnClose: true,
  }),
)
