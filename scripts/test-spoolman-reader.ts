// Opt-in setup WRITES synthetic data. Use only a fresh disposable service.
// Not invoked by CI or check:all.
import assert from 'node:assert/strict'
import { qualificationScope } from './spoolman-qualification-context.ts'
import { createLoopbackSpoolmanReader } from '../packages/connector/src/spoolman/http-read.ts'
import { seedSpoolman } from '../packages/sim-tools/src/spoolman.ts'
const origin = process.env.SPOOLMAN_SYNTHETIC_TEST_ORIGIN
if (!origin || process.env.SPOOLMAN_SYNTHETIC_TEST_DISPOSABLE !== 'yes')
  throw new Error('Explicit disposable synthetic Spoolman origin required')
const context = { ...qualificationScope, limit: 2 }
const read = (limit: number) =>
  createLoopbackSpoolmanReader({
    origin,
    context: { ...context, limit },
    timeoutMs: 10000,
  })()
// Canonical loopback validation and empty inventory required before setup writes.
assert.deepEqual((await read(2)).items, [], 'Requires a fresh empty fixture')
for (let iteration = 0; iteration < 2; iteration++)
  assert.deepEqual(await seedSpoolman(origin), {
    vendors: 2,
    filaments: 4,
    spools: 6,
  })
const baseline = await read(200)
assert.equal(baseline.items.length, 6)
const ids = baseline.items.map((item) => item.id)
assert.deepEqual(
  ids,
  [...ids].sort((a, b) => a - b),
)
assert.equal(new Set(ids).size, 6)
assert.deepEqual(
  baseline.items.map((item) => item.remaining_weight),
  [1000, 900, 800, 700, 600, 500],
)
assert.equal(new Set(baseline.items.map((item) => item.filament.id)).size, 4)
assert.equal(
  new Set(baseline.items.map((item) => item.filament.vendor?.id)).size,
  2,
)
for (const limit of [1, 2, 4]) {
  const result = await read(limit)
  assert.deepEqual(result.items, baseline.items)
  assert.equal(result.farmId, context.farmId)
  assert.equal(result.serviceId, context.serviceId)
}
const archivedId = baseline.items[0]!.id
const response = await fetch(new URL(`/api/v1/spool/${archivedId}`, origin), {
  method: 'PATCH',
  redirect: 'error',
  credentials: 'omit',
  signal: AbortSignal.timeout(5000),
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ archived: true }),
})
assert.equal(response.status, 200)
await response.body?.cancel()
const archived = await read(2)
assert.equal(archived.items.length, 6)
assert.equal(
  archived.items.find((item) => item.id === archivedId)?.archived,
  true,
)
assert.deepEqual(
  archived.items.map((item) => item.remaining_weight),
  baseline.items.map((item) => item.remaining_weight),
)
console.log(
  JSON.stringify({
    result: 'passed',
    empty: true,
    repeatableSeed: true,
    vendors: 2,
    filaments: 4,
    spools: 6,
    pageLimits: [1, 2, 4, 200],
    archivedIncluded: true,
    ascendingIdsAcrossPages: true,
  }),
)
